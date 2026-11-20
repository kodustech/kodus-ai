/**
 * The bytes this process holds of what runtime sandboxes answered, at most
 * `total` at once. Every review in a worker reads through one budget, so an
 * attacker's PR can make its own reads wait but never grow the worker's heap
 * past the budget: a 900 MB sparse file costs nothing to make in the sandbox,
 * and parallel reads of it took a shared 2 GB worker down (OOM, dev cell
 * 2026-11-20), every org's review in it with it.
 *
 * `acquire` waits in line (FIFO) until `n` bytes are free; a request larger
 * than the whole budget is clamped to it, so it waits for an empty budget
 * instead of forever.
 */
export class SandboxReadBudget {
    private used = 0;
    private readonly waiters: Array<{ n: number; resolve: () => void }> = [];

    constructor(readonly total: number) {
        if (!(total > 0))
            throw new Error('SandboxReadBudget: total must be positive');
    }

    /** Bytes held now. */
    get inUse(): number {
        return this.used;
    }

    /** Reserves `n` bytes (clamped to the budget); resolves with what it reserved, to give back. */
    acquire(n: number): Promise<number> {
        const want = Math.min(Math.max(0, Math.ceil(n)), this.total);
        if (!this.waiters.length && this.used + want <= this.total) {
            this.used += want;
            return Promise.resolve(want);
        }
        return new Promise((resolve) =>
            this.waiters.push({ n: want, resolve: () => resolve(want) }),
        );
    }

    release(n: number): void {
        this.used = Math.max(0, this.used - n);
        while (
            this.waiters.length &&
            this.used + this.waiters[0].n <= this.total
        ) {
            const w = this.waiters.shift()!;
            this.used += w.n;
            w.resolve();
        }
    }
}

/** What one worker process holds of sandbox reads at once: room for the graph's largest file and a few tool reads. */
export const SANDBOX_READ_BUDGET_BYTES = 128 * 1024 * 1024;

export const sandboxReadBudget = new SandboxReadBudget(
    SANDBOX_READ_BUDGET_BYTES,
);
