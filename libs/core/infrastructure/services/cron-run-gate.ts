import { runWithBoundedTimeout } from '@libs/core/workflow/infrastructure/run-with-bounded-timeout';

/** How long shutdown waits for a cron run in progress. */
export const CRON_SHUTDOWN_BUDGET_MS = 10_000;

/**
 * Keeps a cron run from outliving the database on shutdown.
 *
 * Nest stops scheduling new ticks on shutdown but lets a run in progress go
 * on, and TypeORM closes its connection in onApplicationShutdown, so every
 * query left in the run fails with "Driver not Connected". Call `stop` from
 * beforeApplicationShutdown, which Nest runs before the connection closes,
 * and check `stopping` before each unit of work.
 */
export class CronRunGate {
    /** Set once shutdown began; read it before each unit of work. */
    stopping = false;
    private current: Promise<unknown> | null = null;

    async run<T>(work: () => Promise<T>): Promise<T | undefined> {
        if (this.stopping) {
            return undefined;
        }
        const running = work();
        this.current = running;
        try {
            return await running;
        } finally {
            if (this.current === running) {
                this.current = null;
            }
        }
    }

    /** Waits for the run in progress, at most `budgetMs`. */
    async stop(budgetMs = CRON_SHUTDOWN_BUDGET_MS): Promise<void> {
        this.stopping = true;
        if (this.current) {
            await runWithBoundedTimeout(
                this.current,
                budgetMs,
                'cron run at shutdown',
            ).catch(() => undefined);
        }
    }
}
