import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { createLogger } from '@libs/core/log/logger';
import { runWithBoundedTimeout } from '@libs/core/workflow/infrastructure/run-with-bounded-timeout';

/** How long shutdown waits for the cron runs in progress. */
export const CRON_SHUTDOWN_BUDGET_MS = 10_000;

type CronOptions = Parameters<typeof Cron>[1];

/**
 * Keeps cron runs from outliving the database on shutdown.
 *
 * Nest stops scheduling new ticks on shutdown but lets a run in progress go
 * on, and TypeORM closes its connection in onApplicationShutdown, so every
 * query left in the run fails with "Driver not Connected". `stop` runs from
 * beforeApplicationShutdown, which Nest runs before the connection closes.
 * A long run reads `stopping` before each unit of work.
 */
export class CronRunGate {
    /** Set once shutdown began; read it before each unit of work. */
    stopping = false;
    // Nest fires a tick even while the previous one still runs, so more
    // than one run can be in flight at shutdown.
    private readonly inFlight = new Set<Promise<unknown>>();
    private stopped: Promise<number> | null = null;

    async run<T>(work: () => Promise<T>): Promise<T | undefined> {
        if (this.stopping) {
            return undefined;
        }
        const running = work();
        this.inFlight.add(running);
        try {
            return await running;
        } finally {
            this.inFlight.delete(running);
        }
    }

    /**
     * Waits for every run in progress, at most `budgetMs` in all, and
     * returns how many were still running when it gave up.
     */
    stop(budgetMs = CRON_SHUTDOWN_BUDGET_MS): Promise<number> {
        // A second caller waits for the same stop, not for a budget of its own.
        this.stopped ??= this.drain(budgetMs);
        return this.stopped;
    }

    private async drain(budgetMs: number): Promise<number> {
        this.stopping = true;
        if (this.inFlight.size === 0) {
            return 0;
        }
        await runWithBoundedTimeout(
            Promise.allSettled([...this.inFlight]),
            budgetMs,
            'cron run at shutdown',
        ).catch(() => undefined);
        return this.inFlight.size;
    }
}

/** The gate every @GatedCron method runs through: one per process. */
export const cronRunGate = new CronRunGate();

/**
 * `@Cron` whose runs go through `gate`: no new run once shutdown began, and
 * shutdown waits for the runs in progress. Use `@GatedCron`; this form takes
 * the gate so a spec can bring its own.
 */
export function gatedCron(
    gate: CronRunGate,
    cronTime: Parameters<typeof Cron>[0],
    options?: CronOptions,
): MethodDecorator {
    return (target, key, descriptor: PropertyDescriptor) => {
        const original = descriptor.value as (...args: unknown[]) => unknown;
        descriptor.value = function (this: unknown, ...args: unknown[]) {
            return gate.run(async () => original.apply(this, args));
        };
        Object.defineProperty(descriptor.value, 'name', {
            value: original.name,
        });
        // Applied after the swap: Cron writes its metadata on the function
        // Nest will call.
        Cron(cronTime, options)(target, key, descriptor);
        return descriptor;
    };
}

/** `@Cron` that shutdown waits for. Every cron in the repository uses it. */
export function GatedCron(
    cronTime: Parameters<typeof Cron>[0],
    options?: CronOptions,
): MethodDecorator {
    return gatedCron(cronRunGate, cronTime, options);
}

/**
 * Stops the @GatedCron runs before the database closes. Provided once, by
 * NotificationModule, which every app imports.
 */
@Injectable()
export class CronShutdownService implements BeforeApplicationShutdown {
    private readonly logger = createLogger(CronShutdownService.name);

    async beforeApplicationShutdown(): Promise<void> {
        const stillRunning = await cronRunGate.stop();
        if (stillRunning > 0) {
            this.logger.warn({
                message:
                    'Shutdown went on with cron runs still in progress; their queries will fail',
                context: CronShutdownService.name,
                metadata: {
                    stillRunning,
                    budgetMs: CRON_SHUTDOWN_BUDGET_MS,
                },
            });
        }
    }
}
