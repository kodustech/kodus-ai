/**
 * Caps how many sandbox leases one worker process holds at once.
 *
 * Every review holds its sandbox for its whole run, and a worker runs up to
 * `prefetch` reviews in parallel, so N workers can ask E2B for N × prefetch
 * live sandboxes and hit the plan's concurrency limit. The cap keeps each
 * worker inside its share: a lease waits up to `waitMs` for a free slot, and
 * the review continues without a sandbox when none frees up.
 *
 * Slots are keyed by a holder id and released explicitly. A holder older
 * than `staleAfterMs` is dropped on the next acquire, so a lease whose
 * release never ran (a bug, not a crash: a crash takes the process with it)
 * cannot shrink the pool forever.
 */

export interface SandboxConcurrencyLimits {
    /** Max leases held at once by this process. 0 or less disables the cap. */
    maxPerWorker: number;
    /** How long a lease waits for a free slot before giving up. */
    waitMs: number;
}

interface Waiter {
    holderId: string;
    resolve: (granted: boolean) => void;
    timer: NodeJS.Timeout;
}

export class SandboxConcurrencyLimiter {
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
     * Resolves true once `holderId` holds a slot, false when `waitMs`
     * elapsed with every slot taken.
     */
    async acquire(
        holderId: string,
        limits: SandboxConcurrencyLimits,
    ): Promise<boolean> {
        this.maxPerWorker = limits.maxPerWorker;
        this.dropStaleHolders();

        if (this.hasFreeSlot()) {
            this.holders.set(holderId, this.now());
            return true;
        }
        if (limits.waitMs <= 0) return false;

        return new Promise<boolean>((resolve) => {
            const waiter: Waiter = {
                holderId,
                resolve,
                timer: setTimeout(() => {
                    this.waiters = this.waiters.filter((w) => w !== waiter);
                    resolve(false);
                }, limits.waitMs),
            };
            this.waiters.push(waiter);
        });
    }

    release(holderId: string): void {
        if (!this.holders.delete(holderId)) return;
        this.grantWaiters();
    }

    private hasFreeSlot(): boolean {
        return this.maxPerWorker <= 0 || this.holders.size < this.maxPerWorker;
    }

    private grantWaiters(): void {
        while (this.waiters.length && this.hasFreeSlot()) {
            const next = this.waiters.shift()!;
            clearTimeout(next.timer);
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
                } catch {
                    // A failing log sink must not block slot accounting
                }
            }
        }
        if (dropped) this.grantWaiters();
    }
}
