import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { metrics, type Meter } from '@opentelemetry/api';

import { createLogger } from '@libs/core/log/logger';
import { type DistributedLock, DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { RuntimePoolController } from '../application/pool-controller.service';

// Every 5 minutes: a schedule opens or closes within that, a warm-up ends,
// and the month's usage moves forward for the budget.
const RUNTIME_CRON_POOL_SCHEDULER = process.env.RUNTIME_CRON_POOL_SCHEDULER || '*/5 * * * *';

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
    ) {}

    @Cron(RUNTIME_CRON_POOL_SCHEDULER, { name: 'Runtime pool scheduler' })
    async handleCron(): Promise<void> {
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
            await lock.release().catch(() => undefined);
        }
    }
}
