import { pruneWorkflowHistory, TERMINAL_WORKFLOW_STATUSES, type WorkflowHistory, type WorkflowRow } from './workflow-retention';

// DBOS keeps every workflow's status, input and step outputs until something
// deletes them (P7): the worker prunes terminal workflows past their age, a
// bounded number of batches per pass, and never one a live Run still needs.
const DAY = 24 * 3_600_000;
const NOW = new Date('2026-11-17T12:00:00Z');

function history(rows: WorkflowRow[]) {
    const store = new Map(rows.map((r) => [r.workflowID, r]));
    const deletes: string[][] = [];
    const lists: Array<{ createdBefore: Date; limit: number; offset: number }> = [];
    const h: WorkflowHistory = {
        async listTerminal(createdBefore, limit, offset) {
            lists.push({ createdBefore, limit, offset });
            return [...store.values()]
                .filter((r) => (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(r.status) && r.createdAt <= createdBefore.getTime())
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(offset, offset + limit);
        },
        async delete(ids) {
            deletes.push(ids);
            for (const id of ids) store.delete(id);
        },
    };
    return { h, store, deletes, lists };
}

const row = (workflowID: string, status: string, ageDays: number): WorkflowRow => ({ workflowID, status, createdAt: NOW.getTime() - ageDays * DAY });
const noneLive = () => false;

describe('pruneWorkflowHistory', () => {
    it('deletes terminal workflows older than the age and keeps newer, pending, enqueued and delayed ones', async () => {
        const { h, store } = history([
            row('old-ok', 'SUCCESS', 40),
            row('old-err', 'ERROR', 31),
            row('old-cancel', 'CANCELLED', 60),
            row('old-max', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 45),
            row('young', 'SUCCESS', 29),
            row('pending', 'PENDING', 90),
            row('enqueued', 'ENQUEUED', 90),
            row('delayed', 'DELAYED', 90),
        ]);
        const r = await pruneWorkflowHistory(h, { now: NOW, isLive: noneLive });
        expect(r.deleted).toBe(4);
        expect([...store.keys()].sort()).toEqual(['delayed', 'enqueued', 'pending', 'young']);
    });

    it('never deletes the workflows of a Run still live in the projection: its own, its approved fork Run and its stop', async () => {
        const { h, store } = history([row('run-1', 'SUCCESS', 40), row('run-1:run', 'SUCCESS', 40), row('run-1:stop', 'SUCCESS', 40), row('run-2', 'SUCCESS', 40)]);
        const r = await pruneWorkflowHistory(h, { now: NOW, isLive: (runId) => runId === 'run-1' });
        expect(r).toMatchObject({ deleted: 1, kept: 3 });
        expect([...store.keys()].sort()).toEqual(['run-1', 'run-1:run', 'run-1:stop']);
    });

    // Measured: 2 500 old terminal workflows, batch 100, cap 20 batches → the first pass deletes
    // 2 000 in 20 transactions of at most 100 workflows, the next one the last 500 in 5.
    it('deletes at most the batch cap per pass, in batches of the batch size, and the next pass goes on', async () => {
        const rows = Array.from({ length: 2_500 }, (_, i) => row(`wf-${i}`, 'SUCCESS', 31 + (i % 300)));
        const { h, store, deletes } = history(rows);
        const first = await pruneWorkflowHistory(h, { now: NOW, isLive: noneLive });
        expect(first).toMatchObject({ deleted: 2_000, batches: 20, more: true });
        expect(Math.max(...deletes.map((d) => d.length))).toBe(100);
        const second = await pruneWorkflowHistory(h, { now: NOW, isLive: noneLive });
        expect(second).toMatchObject({ deleted: 500, batches: 5, more: false });
        expect(store.size).toBe(0);
    });

    it('a page full of live Runs does not stall the pass: it reads past them', async () => {
        const rows = [...Array.from({ length: 150 }, (_, i) => row(`live-${i}`, 'SUCCESS', 90)), row('done', 'SUCCESS', 40)];
        const { h, store } = history(rows);
        const r = await pruneWorkflowHistory(h, { now: NOW, isLive: (id) => id.startsWith('live-') });
        expect(r.deleted).toBe(1);
        expect(store.has('done')).toBe(false);
        expect(store.size).toBe(150);
    });

    it('stops at its time budget between batches', async () => {
        const { h, deletes } = history(Array.from({ length: 500 }, (_, i) => row(`wf-${i}`, 'SUCCESS', 40)));
        let t = 0;
        const r = await pruneWorkflowHistory(h, { now: NOW, isLive: noneLive, clock: () => (t += 10_000), options: { budgetMs: 25_000 } });
        expect(deletes.length).toBeLessThan(5);
        expect(r.more).toBe(true);
    });

    it('lists the workflows created before now minus the age', async () => {
        const { h, lists } = history([]);
        await pruneWorkflowHistory(h, { now: NOW, isLive: noneLive, options: { maxAgeMs: 10 * DAY } });
        expect(lists[0].createdBefore.toISOString()).toBe(new Date(NOW.getTime() - 10 * DAY).toISOString());
    });

    it('refuses an age under the longest a workflow lives (a fork waits 7 days for approval)', async () => {
        const { h } = history([]);
        await expect(pruneWorkflowHistory(h, { now: NOW, isLive: noneLive, options: { maxAgeMs: DAY } })).rejects.toThrow(/at least/);
    });
});
