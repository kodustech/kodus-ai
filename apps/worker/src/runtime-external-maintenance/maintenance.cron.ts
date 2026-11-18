import { metrics, type Meter } from '@opentelemetry/api';
import {
    EXTERNAL_MAINTENANCE_TICK_METRIC,
    EXTERNAL_MAINTENANCE_DURATION_METRIC,
} from '@libs/runtime/api/domain/external-findings';
import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import type { ExternalMaintenanceSweep } from './maintenance-sweep';

export const EXTERNAL_MAINTENANCE_RUNTIME = Symbol(
    'ExternalMaintenanceRuntime',
);
export const EXTERNAL_MAINTENANCE_METRICS = Symbol(
    'ExternalMaintenanceMetrics',
);
export const EXTERNAL_MAINTENANCE_OPTIONS = Symbol(
    'ExternalMaintenanceOptions',
);
export interface ExternalMaintenanceRuntime {
    locks: Pick<DistributedLockService, 'acquire'>;
    sweep: Pick<ExternalMaintenanceSweep, 'run'>;
}
export type ExternalMaintenanceRuntimeFactory =
    () => Promise<ExternalMaintenanceRuntime>;
export interface ExternalMaintenanceOptions {
    enabled: boolean;
    budgetMs: number;
}
/** The worker module passes its process environment (read at boot, worker.module.ts). */
export function isExternalMaintenanceEnabled(env: NodeJS.ProcessEnv): boolean {
    return ['true', '1'].includes(
        env.RUNTIME_EXTERNAL_MAINTENANCE_ENABLED?.trim().toLowerCase() ?? '',
    );
}

export type MaintenanceTickOutcome =
    'ok' | 'failed' | 'lock_failed' | 'skipped' | 'aborted';
export interface ExternalMaintenanceMetrics {
    recordTick(outcome: MaintenanceTickOutcome, durationMs: number): void;
}
export class OtelExternalMaintenanceMetrics implements ExternalMaintenanceMetrics {
    private readonly ticks;
    private readonly duration;
    constructor(meter: Meter = metrics.getMeter('kody-runtime-product')) {
        this.ticks = meter.createCounter(EXTERNAL_MAINTENANCE_TICK_METRIC, {
            description: 'Product external-task maintenance ticks by outcome',
        });
        this.duration = meter.createHistogram(
            EXTERNAL_MAINTENANCE_DURATION_METRIC,
            {
                description: 'Product external-task maintenance duration',
                unit: 'ms',
            },
        );
    }
    recordTick(outcome: MaintenanceTickOutcome, durationMs: number) {
        this.ticks.add(1, { outcome });
        this.duration.record(durationMs, { outcome });
    }
}

/** Which error a tick met: its name and code, and its cause's. Never a message, which may carry credentials or data. */
interface ErrorIdentity {
    name?: string;
    code?: string;
    cause?: ErrorIdentity;
}

function identityOf(error: unknown, depth = 0): ErrorIdentity | undefined {
    if (!error || typeof error !== 'object' || depth > 2) return undefined;
    const e = error as { name?: unknown; code?: unknown; cause?: unknown };
    const cause = identityOf(e.cause, depth + 1);
    return {
        ...(typeof e.name === 'string' ? { name: e.name.slice(0, 64) } : {}),
        ...(typeof e.code === 'string' || typeof e.code === 'number' ? { code: String(e.code).slice(0, 64) } : {}),
        ...(cause ? { cause } : {}),
    };
}

/** Product worker only. The last ten seconds are reserved for bounded DB work and lock release. */
@Injectable()
export class RuntimeExternalMaintenanceCron implements OnModuleDestroy {
    private readonly logger = new Logger(RuntimeExternalMaintenanceCron.name);
    private running = false;
    private closing = false;
    private controller?: AbortController;
    private active?: Promise<void>;
    constructor(
        @Inject(EXTERNAL_MAINTENANCE_RUNTIME)
        private readonly runtime: ExternalMaintenanceRuntimeFactory,
        @Optional()
        @Inject(EXTERNAL_MAINTENANCE_OPTIONS)
        private readonly options: ExternalMaintenanceOptions = {
            enabled: false,
            budgetMs: 40000,
        },
        @Optional()
        @Inject(EXTERNAL_MAINTENANCE_METRICS)
        private readonly telemetry: ExternalMaintenanceMetrics = new OtelExternalMaintenanceMetrics(),
    ) {
        if (
            !Number.isInteger(options.budgetMs) ||
            options.budgetMs < 1000 ||
            options.budgetMs > 40000
        )
            throw new RangeError('Invalid external maintenance budget');
    }
    @Cron('0 * * * * *', { name: 'Runtime external task maintenance' })
    async handleCron(): Promise<void> {
        if (!this.options.enabled || this.closing || this.running) return;
        this.running = true;
        this.active = this.tick();
        try {
            await this.active;
        } finally {
            this.running = false;
            this.active = undefined;
        }
    }
    private async tick(): Promise<void> {
        const started = Date.now();
        const controller = new AbortController();
        this.controller = controller;
        const grace = Math.min(10000, this.options.budgetMs / 2);
        const timer = setTimeout(
            () => controller.abort(),
            this.options.budgetMs - grace,
        );
        let lock: DistributedLock | null = null;
        let outcome: MaintenanceTickOutcome = 'failed';
        let counts:
            Awaited<ReturnType<ExternalMaintenanceSweep['run']>> | undefined;
        let failure: ErrorIdentity | undefined;
        try {
            const runtime = await this.runtime();
            if (controller.signal.aborted) {
                outcome = 'aborted';
                return;
            }
            try {
                lock = await runtime.locks.acquire(
                    'CRON:RUNTIME:EXTERNAL_MAINTENANCE',
                    { ttl: 55000 },
                );
            } catch (error) {
                outcome = 'lock_failed';
                failure = identityOf(error);
                return;
            }
            if (!lock) {
                outcome = 'skipped';
                return;
            }
            if (controller.signal.aborted) {
                outcome = 'aborted';
                return;
            }
            counts = await runtime.sweep.run(controller.signal);
            outcome = controller.signal.aborted ? 'aborted' : 'ok';
        } catch (error) {
            outcome = controller.signal.aborted ? 'aborted' : 'failed';
            failure = identityOf(error);
        } finally {
            clearTimeout(timer);
            if (lock)
                await lock.release().catch(() => {
                    outcome = 'failed';
                });
            this.controller = undefined;
            const durationMs = Math.max(0, Date.now() - started);
            try {
                this.telemetry.recordTick(outcome, durationMs);
            } catch {
                this.logger.warn({
                    msg: 'runtime.a2a.maintenance.telemetry_failed',
                });
            }
            this.logger.log({
                msg: 'runtime.a2a.maintenance',
                outcome,
                durationMs,
                ...(counts ? { counts } : {}),
                ...(failure ? { failure } : {}),
            });
        }
    }
    async onModuleDestroy(): Promise<void> {
        this.closing = true;
        this.controller?.abort();
        await this.active;
    }
}
