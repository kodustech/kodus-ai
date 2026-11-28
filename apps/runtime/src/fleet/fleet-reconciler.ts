import type { DistributedLocks } from '../shared/persistence/locks';
import { reconcileOnce, type ReconcileDeps } from './reconcile';

// The fleet controller's timer (docs/runtime/host-providers.md §7.0): every
// interval, under the cluster lock, one reconcile pass; every tenth pass also
// lists the providers for orphans. A pass that fails is logged and the next
// one runs: the rows are the state, not this process.

export const FLEET_LOCK = 'fleet.reconcile';
const ORPHAN_EVERY = 10;

/** How often the fleet's DBOS history is pruned, at most (as the worker's maintenance tick does its own). */
export const FLEET_HISTORY_PRUNE_EVERY_MS = 3_600_000;

/** The fleet's DBOS history past its age (v-core N10): one bounded pass, never a live host's workflow. */
export interface FleetHistory {
    prune(now: Date): Promise<{ deleted: number; kept: number; more: boolean }>;
}

export class FleetReconciler {
    private timer?: NodeJS.Timeout;
    private passes = 0;
    private running = false;
    private prunedAt = -Infinity;

    constructor(
        private readonly locks: DistributedLocks,
        private readonly deps: ReconcileDeps,
        private readonly intervalMs: number,
        private readonly history?: FleetHistory,
    ) {}

    start() {
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
        this.timer.unref?.();
        void this.tick();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }

    async tick(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            const orphans = this.passes++ % ORPHAN_EVERY === 0;
            await this.locks.tryWithLock(FLEET_LOCK, async () => {
                try {
                    await reconcileOnce(this.deps, { orphans });
                } finally {
                    await this.pruneHistory();
                }
            });
        } catch (e) {
            this.deps.log('fleet.reconcile_failed', { error: (e as Error).name });
        } finally {
            this.running = false;
        }
    }

    /** Hourly, under the reconcile lock; a failure is logged and the next hour tries again. */
    private async pruneHistory(): Promise<void> {
        const now = this.deps.now();
        if (!this.history || now - this.prunedAt < FLEET_HISTORY_PRUNE_EVERY_MS) return;
        this.prunedAt = now;
        try {
            const r = await this.history.prune(new Date(now));
            if (r.deleted || r.more) this.deps.log('fleet.retention.workflows', { deleted: r.deleted, kept: r.kept, more: r.more });
        } catch (e) {
            this.deps.log('fleet.retention.workflows_failed', { error: (e as Error).name });
        }
    }
}
