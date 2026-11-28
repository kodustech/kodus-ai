import type { WorkflowHistory, WorkflowRow } from '../shared/persistence/workflow-retention';

import { perRunWorkflowId, pruneFleetHistory } from './fleet-engine';
import { FleetReconciler } from './fleet-reconciler';

// v-core N10: the fleet's own DBOS system database (fleet.perRun, one
// workflow per host) was never pruned. It is now, hourly, past the worker's
// age, never a workflow whose host is still live.

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-12-31T00:00:00.000Z');

class History implements WorkflowHistory {
    constructor(public rows: WorkflowRow[]) {}
    async listTerminal(before: Date, limit: number, offset: number) {
        return this.rows.filter((r) => r.createdAt < before.getTime()).slice(offset, offset + limit);
    }
    async delete(ids: string[]) {
        this.rows = this.rows.filter((r) => !ids.includes(r.workflowID));
    }
}

const row = (hostId: string, ageDays: number): WorkflowRow => ({ workflowID: perRunWorkflowId(hostId), status: 'SUCCESS', createdAt: NOW.getTime() - ageDays * DAY });

describe("the fleet's DBOS history", () => {
    it('deletes old terminal host workflows, keeps a live host and a recent one', async () => {
        const history = new History([row('h-old', 40), row('h-live', 40), row('h-new', 2)]);
        const r = await pruneFleetHistory({ liveHosts: async () => [{ hostId: 'h-live' }] }, NOW, history);
        expect(r.deleted).toBe(1);
        expect(history.rows.map((w) => w.workflowID)).toEqual([perRunWorkflowId('h-live'), perRunWorkflowId('h-new')]);
    });

    it('the reconciler prunes once an hour, under its lock', async () => {
        let t = 0;
        const prune = jest.fn(async () => ({ deleted: 0, kept: 0, more: false }));
        const locks = { tryWithLock: async (_k: string, fn: () => Promise<unknown>) => fn() };
        const deps = { store: { controlledPools: async () => ({ pools: [], invalid: [] }) }, now: () => t, log: () => undefined, providerFor: () => undefined } as any;
        const reconciler = new FleetReconciler(locks as any, deps, 1_000, { prune });
        await reconciler.tick();
        t += 30 * 60_000;
        await reconciler.tick();
        t += 31 * 60_000;
        await reconciler.tick();
        expect(prune).toHaveBeenCalledTimes(2);
    });
});
