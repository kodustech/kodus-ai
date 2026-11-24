import { Inject, Injectable, Optional } from '@nestjs/common';
import { GatedCron } from '@libs/core/infrastructure/services/cron-run-gate';
import { RUNTIME_CRON_SCHEDULES } from './runtime-cron-schedules';
import { metrics, type Meter } from '@opentelemetry/api';

import { createLogger } from '@libs/core/log/logger';
import { kodyRuntimeEnabledInThisProcess } from '@libs/runtime-publish/runtime-feature';
import { type DistributedLock, DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { RuntimePoolController } from '../application/pool-controller.service';
import { RuntimeSuiteBaselineRequests } from '../application/suite-baseline-requests.service';
import { RuntimeSuiteShadowRequests } from '../application/suite-shadow-requests.service';
import { RuntimeTemplateSetupRequests } from '../application/template-setup-requests.service';

// Every 5 minutes: a schedule opens or closes within that, a warm-up ends,
// and the month's usage moves forward for the budget.

export const POOL_SCHEDULER_TICK_METRIC = 'runtime.pool_scheduler.tick';

/** ok, failed (the tick threw), lock_failed (the lock could not be asked for), skipped (another replica holds it). */
export type PoolSchedulerTickOutcome = 'ok' | 'failed' | 'lock_failed' | 'skipped';

export interface PoolSchedulerMetrics {
    recordTick(outcome: PoolSchedulerTickOutcome): void;
}

export const RUNTIME_POOL_SCHEDULER_METRICS = Symbol.for('RuntimePoolSchedulerMetrics');

/** A tick that fails every 5 minutes only logs otherwise: this counter is what an alert watches. */
export class OtelPoolSchedulerMetrics implements PoolSchedulerMetrics {
    private readonly ticks;

    constructor(meter: Meter = metrics.getMeter('kody-runtime-api')) {
        this.ticks = meter.createCounter(POOL_SCHEDULER_TICK_METRIC, {
            description: 'Runtime pool scheduler ticks by outcome',
        });
    }

    recordTick(outcome: PoolSchedulerTickOutcome): void {
        this.ticks.add(1, { outcome });
    }
}

/** Runs the pool controller's tick on one API replica at a time. */
@Injectable()
export class RuntimePoolSchedulerCron {
    private readonly logger = createLogger(RuntimePoolSchedulerCron.name);

    constructor(
        private readonly pool: RuntimePoolController,
        private readonly locks: DistributedLockService,
        @Optional()
        @Inject(RUNTIME_POOL_SCHEDULER_METRICS)
        private readonly metrics: PoolSchedulerMetrics = new OtelPoolSchedulerMetrics(),
        // The fleet's environment template builds wait for their setup command; asked on the same lock and schedule.
        @Optional()
        private readonly templateSetups?: RuntimeTemplateSetupRequests,
        // The baseline suite runs a template turning ready asked for (docs/runtime/e2e-suites.md section 2.1); same lock, same schedule.
        @Optional()
        private readonly suiteBaselines?: RuntimeSuiteBaselineRequests,
        // The shadows of selected PR runs (D14): the whole suite in the background; same lock, same schedule.
        @Optional()
        private readonly suiteShadows?: RuntimeSuiteShadowRequests,
    ) {}

    @GatedCron(RUNTIME_CRON_SCHEDULES.poolScheduler, { name: 'Runtime pool scheduler' })
    async handleCron(): Promise<void> {
        // The API imports the Runtime everywhere; a deployment without it has no pool to schedule.
        if (!kodyRuntimeEnabledInThisProcess()) return;
        let lock: DistributedLock | null;
        try {
            lock = await this.locks.acquire('CRON:RUNTIME:POOL_SCHEDULER', { ttl: 4 * 60 * 1000 });
        } catch (error) {
            this.metrics.recordTick('lock_failed');
            this.logger.error({
                message: 'Runtime pool scheduler: lock failed',
                context: RuntimePoolSchedulerCron.name,
                error: error instanceof Error ? error : undefined,
            });
            return;
        }
        if (!lock) {
            this.metrics.recordTick('skipped');
            return;
        }
        try {
            const out = await this.pool.tick();
            this.metrics.recordTick('ok');
            if (out.checked) this.logger.log({ message: 'Runtime pool scheduler: tick', context: RuntimePoolSchedulerCron.name, metadata: out });
        } catch (error) {
            this.metrics.recordTick('failed');
            this.logger.error({
                message: 'Runtime pool scheduler: tick failed',
                context: RuntimePoolSchedulerCron.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            await this.requestTemplateSetups();
            await this.requestSuiteBaselines();
            await this.requestSuiteShadows();
            // DistributedLock.release logs its own failure, and the TTL frees the lock anyway.
            await lock.release().catch(() => undefined);
        }
    }

    /** Never throws and never counts as a failed tick: the pool's schedule does not wait on a template build. */
    private async requestTemplateSetups(): Promise<void> {
        if (!this.templateSetups) return;
        try {
            const out = await this.templateSetups.run();
            if (out.pending) this.logger.log({ message: 'Runtime template setups: pass', context: RuntimePoolSchedulerCron.name, metadata: out });
        } catch (error) {
            this.logger.error({ message: 'Runtime template setups: pass failed', context: RuntimePoolSchedulerCron.name, error: error instanceof Error ? error : undefined });
        }
    }

    /** Never throws and never counts as a failed tick: the pool's schedule does not wait on a baseline. */
    private async requestSuiteBaselines(): Promise<void> {
        if (!this.suiteBaselines) return;
        try {
            const out = await this.suiteBaselines.run();
            if (out.pending) this.logger.log({ message: 'Runtime suite baselines: pass', context: RuntimePoolSchedulerCron.name, metadata: out });
        } catch (error) {
            this.logger.error({ message: 'Runtime suite baselines: pass failed', context: RuntimePoolSchedulerCron.name, error: error instanceof Error ? error : undefined });
        }
    }

    /** Never throws and never counts as a failed tick: the pool's schedule does not wait on a shadow. */
    private async requestSuiteShadows(): Promise<void> {
        if (!this.suiteShadows) return;
        try {
            const out = await this.suiteShadows.run();
            if (out.pending) this.logger.log({ message: 'Runtime suite shadows: pass', context: RuntimePoolSchedulerCron.name, metadata: out });
        } catch (error) {
            this.logger.error({ message: 'Runtime suite shadows: pass failed', context: RuntimePoolSchedulerCron.name, error: error instanceof Error ? error : undefined });
        }
    }
}
