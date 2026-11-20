import { randomUUID } from 'crypto';

import { createLogger } from '@libs/core/log/logger';

/**
 * Deployment-wide cap on sandboxes held at once, shared by every worker.
 *
 * `SANDBOX_MAX_CONCURRENT` slots, kept in Mongo next to the sandbox leases
 * (sandbox-capacity.model.ts). A review inserts a ticket; only the oldest live
 * ticket (createdAt, then _id) may try to take a slot, so the line is FIFO
 * across every worker. Taking a slot is one atomic update of the single state
 * document, so racing workers never exceed the cap. A worker heartbeats its
 * tickets and slots; entries silent for DEAD_AFTER_MS belong to a crashed
 * worker and stop counting, with nothing pinned (no connection, no lock).
 *
 * With no cap configured the gate is off and grants at once (today's
 * behavior).
 */

export const DEFAULT_SANDBOX_QUEUE_MAX_WAIT_MS = 10 * 60_000;

export interface SandboxCapacityEnv {
    /** Deployment-wide cap; 0 = no cap. */
    maxConcurrent: number;
    /** How long a review waits for capacity before it runs without a sandbox. */
    maxWaitMs: number;
}

/** Reads the knobs; a missing or malformed value means "off" / the default. */
export function readSandboxCapacityEnv(
    env: Record<string, string | undefined> = process.env,
): SandboxCapacityEnv {
    const int = (value: string | undefined, fallback: number) => {
        const n = Number(value);
        return value && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    };
    return {
        maxConcurrent: int(env.SANDBOX_MAX_CONCURRENT, 0),
        maxWaitMs: int(
            env.SANDBOX_QUEUE_MAX_WAIT_MS,
            DEFAULT_SANDBOX_QUEUE_MAX_WAIT_MS,
        ),
    };
}

export interface CapacityNumbers {
    inUse: number;
    queued: number;
    oldestCreatedAt: Date | null;
}

/** Where tickets and slots live. Production: Mongo; specs: a shared fake. */
export interface SandboxCapacityStore {
    enqueue(
        t: { id: string; prKey: string; workerId: string },
        now: Date,
    ): Promise<void>;
    /** Refreshes a waiting ticket's heartbeat; false when it is gone (cancelled). */
    touch(id: string, now: Date): Promise<boolean>;
    /** No older live ticket is waiting. */
    isHead(id: string, deadBefore: Date): Promise<boolean>;
    /** Atomic: takes a slot for `id` only while fewer than `cap` live slots exist. */
    tryAdmit(
        id: string,
        cap: number,
        now: Date,
        deadBefore: Date,
    ): Promise<boolean>;
    heartbeatSlot(id: string, now: Date): Promise<void>;
    releaseSlot(id: string): Promise<void>;
    removeTicket(id: string): Promise<void>;
    removeTicketsByPrKey(prKey: string): Promise<number>;
    numbers(deadBefore: Date): Promise<CapacityNumbers>;
}

export const SANDBOX_CAPACITY_GATE_TOKEN = Symbol('SANDBOX_CAPACITY_GATE_TOKEN');

export type CapacityGrant =
    | { outcome: 'granted'; waitedMs: number; release: () => Promise<void> }
    | { outcome: 'timeout'; waitedMs: number }
    | { outcome: 'cancelled'; waitedMs: number };

export interface SandboxCapacityNumbers {
    /** Slots held right now across every worker (null when no cap is set). */
    inUse: number | null;
    /** The cap; 0 = none. */
    cap: number;
    /** Reviews waiting, across every worker. */
    queued: number;
    /** Longest wait in the line, ms. */
    oldestWaitMs: number;
}

export interface SandboxCapacityTiming {
    pollMs: number;
    heartbeatMs: number;
    /** Heartbeat older than this = the worker is dead (3x the heartbeat). */
    deadAfterMs: number;
}

export const DEFAULT_CAPACITY_TIMING: SandboxCapacityTiming = {
    pollMs: 2_000,
    heartbeatMs: 15_000,
    deadAfterMs: 45_000,
};

export class SandboxCapacityGate {
    private readonly logger = createLogger(SandboxCapacityGate.name);
    private readonly workerId = randomUUID();

    constructor(
        private readonly store?: SandboxCapacityStore,
        private readonly env: () => SandboxCapacityEnv = readSandboxCapacityEnv,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = (ms) =>
            new Promise((r) => setTimeout(r, ms)),
        private readonly timing: SandboxCapacityTiming = DEFAULT_CAPACITY_TIMING,
    ) {}

    get enabled(): boolean {
        return !!this.store && this.env().maxConcurrent > 0;
    }

    get maxConcurrent(): number {
        return this.env().maxConcurrent;
    }

    get maxWaitMs(): number {
        return this.env().maxWaitMs;
    }

    private deadBefore(): Date {
        return new Date(this.now() - this.timing.deadAfterMs);
    }

    /**
     * Waits for a deployment slot, in line by createdAt across all workers.
     * Granted at once when the cap is off. Ends with `timeout` after the max
     * wait (the caller runs without a sandbox) or `cancelled` when the ticket
     * was deleted (cancel, a newer event) or `signal` fired.
     */
    async acquire(
        holderId: string,
        prKey: string,
        signal?: AbortSignal,
    ): Promise<CapacityGrant> {
        const { maxConcurrent, maxWaitMs } = this.env();
        const store = this.store;
        if (!store || maxConcurrent <= 0) {
            return { outcome: 'granted', waitedMs: 0, release: async () => {} };
        }
        const startedAt = this.now();
        await store.enqueue(
            { id: holderId, prKey, workerId: this.workerId },
            new Date(startedAt),
        );
        try {
            for (;;) {
                const waitedMs = this.now() - startedAt;
                if (signal?.aborted) {
                    return { outcome: 'cancelled', waitedMs };
                }
                if (waitedMs >= maxWaitMs) return { outcome: 'timeout', waitedMs };
                // A ticket deleted by another worker (invalidate) is cancelled
                if (!(await store.touch(holderId, new Date(this.now())))) {
                    return { outcome: 'cancelled', waitedMs };
                }
                if (
                    (await store.isHead(holderId, this.deadBefore())) &&
                    (await store.tryAdmit(
                        holderId,
                        maxConcurrent,
                        new Date(this.now()),
                        this.deadBefore(),
                    ))
                ) {
                    return this.granted(store, holderId, startedAt);
                }
                await this.sleep(
                    Math.min(this.timing.pollMs, Math.max(maxWaitMs - waitedMs, 1)),
                );
            }
        } catch (error) {
            await store.removeTicket(holderId).catch(() => {});
            throw error;
        } finally {
            // Admitted tickets are already gone; this drops the rest
            await store.removeTicket(holderId).catch(() => {});
        }
    }

    private granted(
        store: SandboxCapacityStore,
        holderId: string,
        startedAt: number,
    ): CapacityGrant {
        const beat = setInterval(() => {
            store
                .heartbeatSlot(holderId, new Date(this.now()))
                .catch((error) =>
                    this.logger.warn({
                        message: 'SandboxCapacityGate: slot heartbeat failed',
                        context: SandboxCapacityGate.name,
                        error,
                        metadata: { holderId },
                    }),
                );
        }, this.timing.heartbeatMs);
        beat.unref?.();
        let released = false;
        return {
            outcome: 'granted',
            waitedMs: this.now() - startedAt,
            release: async () => {
                if (released) return;
                released = true;
                clearInterval(beat);
                await store.releaseSlot(holderId);
            },
        };
    }

    /** Takes a holder out of the line, on any worker (the ticket is deleted). */
    async cancel(holderId: string): Promise<void> {
        await this.store?.removeTicket(holderId).catch(() => {});
    }

    /** A newer event on the PR (closed, force-pushed): drops its waiting tickets. */
    async cancelPrKey(prKey: string): Promise<number> {
        return (await this.store?.removeTicketsByPrKey(prKey).catch(() => 0)) ?? 0;
    }

    /** The numbers for a later screen, deployment-wide, read from Mongo. */
    async numbers(): Promise<SandboxCapacityNumbers> {
        const { maxConcurrent } = this.env();
        if (!this.store || maxConcurrent <= 0) {
            return { inUse: null, cap: 0, queued: 0, oldestWaitMs: 0 };
        }
        const n = await this.store.numbers(this.deadBefore());
        return {
            inUse: n.inUse,
            cap: maxConcurrent,
            queued: n.queued,
            oldestWaitMs: n.oldestCreatedAt
                ? this.now() - n.oldestCreatedAt.getTime()
                : 0,
        };
    }
}
