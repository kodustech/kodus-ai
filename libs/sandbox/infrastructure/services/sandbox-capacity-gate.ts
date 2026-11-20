import { createLogger } from '@libs/core/log/logger';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

/**
 * Deployment-wide cap on sandboxes held at once, shared by every worker.
 *
 * The cap is `SANDBOX_MAX_CONCURRENT` slots. A slot is a Postgres advisory
 * lock (`sandbox-capacity:slot:<i>`, the pattern the BYOK concurrency gate
 * already uses): whoever holds slot i holds one sandbox, and a crashed
 * worker's connection takes its locks with it, so slots cannot leak.
 *
 * Ordering: within one worker the line is strictly FIFO (only the head of the
 * local line polls). Across workers it is first-to-poll: advisory locks carry
 * no queue, so two workers racing for the same freed slot are not ordered.
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

/** One held slot; release() frees it for every worker. */
export interface SandboxCapacitySlot {
    release(): Promise<void>;
}

/** Where slots live. Production: advisory locks; specs: a shared fake. */
export interface SandboxCapacityStore {
    tryAcquire(slotIndex: number): Promise<SandboxCapacitySlot | null>;
    isHeld(slotIndex: number): Promise<boolean>;
}

export const SANDBOX_CAPACITY_STORE_TOKEN = Symbol(
    'SANDBOX_CAPACITY_STORE_TOKEN',
);

const SLOT_KEY = (i: number) => `sandbox-capacity:slot:${i}`;

export class AdvisoryLockCapacityStore implements SandboxCapacityStore {
    constructor(private readonly locks: DistributedLockService) {}

    async tryAcquire(slotIndex: number): Promise<SandboxCapacitySlot | null> {
        const lock = await this.locks.acquire(SLOT_KEY(slotIndex));
        return lock ? { release: () => lock.release() } : null;
    }

    isHeld(slotIndex: number): Promise<boolean> {
        return this.locks.isLocked(SLOT_KEY(slotIndex));
    }
}

export type CapacityGrant =
    | { outcome: 'granted'; waitedMs: number; release: () => Promise<void> }
    | { outcome: 'timeout'; waitedMs: number }
    | { outcome: 'cancelled'; waitedMs: number };

export interface SandboxCapacityNumbers {
    /** Slots held right now across every worker (null when no cap is set). */
    inUse: number | null;
    /** The cap; 0 = none. */
    cap: number;
    /** Reviews waiting in this worker's line. */
    queued: number;
    /** Longest wait in this worker's line, ms. */
    oldestWaitMs: number;
}

interface Ticket {
    holderId: string;
    since: number;
    cancel: () => void;
    cancelled: boolean;
}

const POLL_MIN_MS = 1_000;
const POLL_MAX_MS = 5_000;

export class SandboxCapacityGate {
    private readonly logger = createLogger(SandboxCapacityGate.name);
    private readonly line: Ticket[] = [];
    private cap = 0;

    constructor(
        private readonly store?: SandboxCapacityStore,
        private readonly env: () => SandboxCapacityEnv = readSandboxCapacityEnv,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = (ms) =>
            new Promise((r) => setTimeout(r, ms)),
    ) {}

    get enabled(): boolean {
        return !!this.store && this.env().maxConcurrent > 0;
    }

    get maxWaitMs(): number {
        return this.env().maxWaitMs;
    }

    /**
     * Waits for a deployment slot. Granted at once when the cap is off. Ends
     * with `timeout` after the max wait (the caller runs without a sandbox) or
     * `cancelled` when cancel(holderId) or `signal` fired first.
     */
    async acquire(
        holderId: string,
        signal?: AbortSignal,
    ): Promise<CapacityGrant> {
        const { maxConcurrent, maxWaitMs } = this.env();
        if (!this.store || maxConcurrent <= 0) {
            return { outcome: 'granted', waitedMs: 0, release: async () => {} };
        }
        this.cap = maxConcurrent;
        const startedAt = this.now();
        const ticket: Ticket = {
            holderId,
            since: startedAt,
            cancelled: false,
            cancel: () => {
                ticket.cancelled = true;
            },
        };
        const onAbort = () => ticket.cancel();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) ticket.cancel();
        this.line.push(ticket);

        try {
            for (let tick = 0; ; tick++) {
                const waitedMs = this.now() - startedAt;
                if (ticket.cancelled) return { outcome: 'cancelled', waitedMs };
                if (waitedMs >= maxWaitMs) return { outcome: 'timeout', waitedMs };

                // Only the head of this worker's line polls: FIFO locally
                if (this.line[0] === ticket) {
                    const slot = await this.tryAnySlot(maxConcurrent);
                    if (slot) {
                        if (ticket.cancelled) {
                            await slot.release();
                            return { outcome: 'cancelled', waitedMs };
                        }
                        return {
                            outcome: 'granted',
                            waitedMs: this.now() - startedAt,
                            release: () => slot.release(),
                        };
                    }
                }
                const jitter = POLL_MIN_MS + Math.random() * (POLL_MAX_MS - POLL_MIN_MS);
                await this.sleep(Math.min(jitter, Math.max(maxWaitMs - waitedMs, 1)));
            }
        } finally {
            signal?.removeEventListener('abort', onAbort);
            const i = this.line.indexOf(ticket);
            if (i !== -1) this.line.splice(i, 1);
        }
    }

    /** Takes a holder out of this worker's line (a newer push, a close). */
    cancel(holderId: string): number {
        let n = 0;
        for (const t of this.line) {
            if (t.holderId === holderId && !t.cancelled) {
                t.cancel();
                n++;
            }
        }
        return n;
    }

    /** The numbers for a later screen: in-use, queued, oldest wait. */
    async numbers(): Promise<SandboxCapacityNumbers> {
        const { maxConcurrent } = this.env();
        const now = this.now();
        let inUse: number | null = null;
        if (this.store && maxConcurrent > 0) {
            inUse = 0;
            for (let i = 0; i < maxConcurrent; i++) {
                if (await this.store.isHeld(i)) inUse++;
            }
        }
        return {
            inUse,
            cap: maxConcurrent,
            queued: this.line.length,
            oldestWaitMs: this.line.length
                ? now - Math.min(...this.line.map((t) => t.since))
                : 0,
        };
    }

    private async tryAnySlot(cap: number): Promise<SandboxCapacitySlot | null> {
        for (let i = 0; i < cap; i++) {
            try {
                const slot = await this.store!.tryAcquire(i);
                if (slot) return slot;
            } catch (error) {
                this.logger.warn({
                    message: 'SandboxCapacityGate: could not try a slot; will retry',
                    context: SandboxCapacityGate.name,
                    error,
                    metadata: { slotIndex: i },
                });
                return null;
            }
        }
        return null;
    }
}
