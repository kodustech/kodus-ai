import {
    BeforeApplicationShutdown,
    Injectable,
    OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronTime } from 'cron';

import { createLogger } from '@libs/core/log/logger';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { runWithBoundedTimeout } from '@libs/core/workflow/infrastructure/run-with-bounded-timeout';

/** How long shutdown waits for the cron runs in progress. */
export const CRON_SHUTDOWN_BUDGET_MS = 10_000;

/** Longest a tick stays claimed; replicas fire within seconds of each other. */
export const MAX_TICK_HOLD_MS = 60 * 60 * 1000;

type CronOptions = Parameters<typeof Cron>[1];

/**
 * Takes the tick of `cron` for `holdMs` across every process; true when this
 * process got it. Throws when the claim cannot be made.
 */
export type TickClaim = (cron: string, holdMs: number) => Promise<boolean>;

/** The tick a scheduled method claims before it runs. */
interface Tick {
    cron: string;
    holdMs: number;
}

const logger = createLogger('CronRunGate');

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
    private claim: TickClaim | null = null;

    /**
     * Makes each tick run in one process only. Without it (specs, scripts)
     * every tick runs.
     */
    claimTicksWith(claim: TickClaim | null): void {
        this.claim = claim;
    }

    async run<T>(work: () => Promise<T>, tick?: Tick): Promise<T | undefined> {
        if (this.stopping) {
            return undefined;
        }
        // The claim counts as part of the run, so shutdown waits for it too.
        const running =
            tick && this.claim
                ? this.claimThenRun(this.claim, tick, work)
                : work();
        this.inFlight.add(running);
        try {
            return await running;
        } finally {
            this.inFlight.delete(running);
        }
    }

    private async claimThenRun<T>(
        claim: TickClaim,
        tick: Tick,
        work: () => Promise<T>,
    ): Promise<T | undefined> {
        if (!(await this.claimed(claim, tick))) {
            return undefined;
        }
        // Shutdown may have begun while the claim was in flight.
        if (this.stopping) {
            return undefined;
        }
        return work();
    }

    private async claimed(claim: TickClaim, tick: Tick): Promise<boolean> {
        try {
            return await claim(tick.cron, tick.holdMs);
        } catch (error) {
            // Every replica ran every tick before claims; the cron's own
            // lock still keeps two runs from overlapping.
            logger.warn({
                message: 'Could not claim the cron tick — running it anyway',
                context: CronRunGate.name,
                error: error instanceof Error ? error : undefined,
                metadata: { cron: tick.cron },
            });
            return true;
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
 * How long a tick stays claimed: half the shortest gap between ticks, so the
 * next tick is free again, and at most MAX_TICK_HOLD_MS. A replica whose
 * tick fires later than that (event loop blocked longer) runs it again.
 * Null for a one-off date, which needs no claim.
 */
export function tickHoldMs(
    cronTime: Parameters<typeof Cron>[0],
): number | null {
    if (typeof cronTime !== 'string') {
        return null;
    }
    let next: number[];
    try {
        // The gaps are the same in every time zone but across a DST
        // change, which only shortens a daily gap by an hour.
        next = new CronTime(cronTime, 'UTC')
            .sendAt(6)
            .map((at) => at.toMillis());
    } catch {
        // Nest rejects the expression when it registers the cron, with a
        // better error than this one.
        return null;
    }
    const gap = Math.min(...next.slice(1).map((at, i) => at - next[i]));
    return Math.min(Math.floor(gap / 2), MAX_TICK_HOLD_MS);
}

/**
 * `@Cron` whose runs go through `gate`: one process per tick when the gate
 * claims ticks, no new run once shutdown began, and shutdown waits for the
 * runs in progress. Use `@GatedCron`; this form takes the gate so a spec can
 * bring its own.
 */
export function gatedCron(
    gate: CronRunGate,
    cronTime: Parameters<typeof Cron>[0],
    options?: CronOptions,
): MethodDecorator {
    return (target, key, descriptor: PropertyDescriptor) => {
        const original = descriptor.value as (...args: unknown[]) => unknown;
        const holdMs = tickHoldMs(cronTime);
        // Class and method: the same in every replica, unique per cron.
        const tick =
            holdMs === null
                ? undefined
                : {
                      cron: `${target.constructor.name}.${String(key)}`,
                      holdMs,
                  };
        descriptor.value = function (this: unknown, ...args: unknown[]) {
            return gate.run(async () => original.apply(this, args), tick);
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

/**
 * `@Cron` that runs once per tick across replicas and that shutdown waits
 * for. Every cron in the repository uses it.
 */
export function GatedCron(
    cronTime: Parameters<typeof Cron>[0],
    options?: CronOptions,
): MethodDecorator {
    return gatedCron(cronRunGate, cronTime, options);
}

/**
 * Claims @GatedCron ticks on the lease table, and stops the runs before the
 * database closes. Provided once, by NotificationModule, which every app
 * imports.
 */
@Injectable()
export class CronShutdownService
    implements OnModuleInit, BeforeApplicationShutdown
{
    private readonly logger = createLogger(CronShutdownService.name);

    constructor(private readonly locks: DistributedLockService) {}

    onModuleInit(): void {
        // Before onApplicationBootstrap, where Nest starts the crons.
        cronRunGate.claimTicksWith((cron, holdMs) =>
            this.locks.claim(`CRON_TICK:${cron}`, holdMs),
        );
    }

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
