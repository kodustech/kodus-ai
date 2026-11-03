import { createLogger } from '@libs/core/log/logger';

/**
 * Caps how many sandbox leases one worker process holds at once.
 *
 * Every review holds its sandbox for its whole run, and a worker runs up to
 * `prefetch` reviews in parallel, so N workers can ask E2B for N × prefetch
 * live sandboxes and hit the plan's concurrency limit. The cap keeps each
 * worker inside its share. A review never gives its sandbox up: when every
 * slot is taken it queues (FIFO) until one frees.
 *
 * Slots are keyed by a holder id and released explicitly. A holder older
 * than `staleAfterMs` is dropped on the next acquire, so a lease whose
 * release never ran (a bug, not a crash: a crash takes the process with it)
 * cannot shrink the pool forever.
 */

export interface SandboxConcurrencyLimits {
    /** Max leases held at once by this process. 0 or less disables the cap. */
    maxPerWorker: number;
}

interface Waiter {
    holderId: string;
    resolve: (granted: boolean) => void;
}

export class SandboxConcurrencyLimiter {
    private readonly logger = createLogger(SandboxConcurrencyLimiter.name);
    private readonly holders = new Map<string, number>();
    private waiters: Waiter[] = [];
    private maxPerWorker = 0;

    constructor(
        private readonly staleAfterMs: number,
        private readonly now: () => number = Date.now,
        /** Called for each holder dropped as stale: a release() that never ran. */
        private readonly onStaleHolder?: (
            holderId: string,
            heldMs: number,
        ) => void,
    ) {}

    get active(): number {
        return this.holders.size;
    }

    get waiting(): number {
        return this.waiters.length;
    }

    /**
     * Resolves true once `holderId` holds a slot, waiting in line for as long
     * as it takes; false only when release() withdrew it from the line first.
     */
    acquire(holderId: string, maxPerWorker: number): Promise<boolean> {
        this.maxPerWorker = maxPerWorker;
        this.dropStaleHolders();

        if (!this.waiters.length && this.hasFreeSlot()) {
            this.holders.set(holderId, this.now());
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            this.waiters.push({ holderId, resolve });
            this.grantWaiters();
        });
    }

    /** Applies a new cap; raising it admits waiters at once. */
    setLimit(maxPerWorker: number): void {
        this.maxPerWorker = maxPerWorker;
        this.dropStaleHolders();
        this.grantWaiters();
    }

    /** Frees `holderId`'s slot, or takes it out of the line if still waiting. */
    release(holderId: string): void {
        if (this.holders.delete(holderId)) {
            this.grantWaiters();
            return;
        }
        const index = this.waiters.findIndex((w) => w.holderId === holderId);
        if (index !== -1) {
            const [waiter] = this.waiters.splice(index, 1);
            waiter.resolve(false);
        }
    }

    private hasFreeSlot(): boolean {
        return this.maxPerWorker <= 0 || this.holders.size < this.maxPerWorker;
    }

    private grantWaiters(): void {
        while (this.waiters.length && this.hasFreeSlot()) {
            const next = this.waiters.shift()!;
            this.holders.set(next.holderId, this.now());
            next.resolve(true);
        }
    }

    private dropStaleHolders(): void {
        const now = this.now();
        const cutoff = now - this.staleAfterMs;
        let dropped = false;
        for (const [holderId, since] of this.holders) {
            if (since < cutoff) {
                this.holders.delete(holderId);
                dropped = true;
                try {
                    this.onStaleHolder?.(holderId, now - since);
                } catch (error) {
                    // A failing sink must not block slot accounting, and the
                    // drop (a release() that never ran) must still be seen
                    this.reportLostStaleHolder(holderId, now - since, error);
                }
            }
        }
        if (dropped) this.grantWaiters();
    }

    private reportLostStaleHolder(
        holderId: string,
        heldMs: number,
        error: unknown,
    ): void {
        try {
            this.logger.warn({
                message: `SandboxConcurrencyLimiter: dropped holder ${holderId} after ${heldMs}ms without release (its report failed)`,
                context: SandboxConcurrencyLimiter.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { holderId, heldMs },
            });
        } catch {
            // The logger is down too: stderr is the last sink left
            process.emitWarning(
                `SandboxConcurrencyLimiter: dropped holder ${holderId} after ${heldMs}ms without release`,
                { code: 'SANDBOX_STALE_HOLDER_REPORT_LOST' },
            );
        }
    }
}
