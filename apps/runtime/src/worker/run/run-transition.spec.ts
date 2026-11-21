import { transition } from './run-orchestrator';
import { inMemoryRunDeps } from './testing';

// v-core N6: a stop writes `superseded` while the Run's own `state:regression`
// step is in flight. The stop wins whole: the late move writes nothing of its
// patch, says nothing on the stream and counts nothing.

describe('transition after another writer ended the Run', () => {
    const req = { runId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', organizationId: 'org-1', attempt: 1, trigger: 'pull_request' };

    it('a late move to another terminal state writes, says and counts nothing', async () => {
        const h = inMemoryRunDeps();
        await h.projection.upsert(req.runId, { runId: req.runId, organizationId: req.organizationId, state: 'testing' } as any);
        // The step read `testing`, then a stop ended the Run before its write.
        const get = h.projection.get.bind(h.projection);
        let first = true;
        h.deps.projection.get = async (id: string) => {
            const run = await get(id);
            if (first) {
                first = false;
                await h.projection.upsert(req.runId, { state: 'superseded', check: { conclusion: 'cancelled', title: 'Superseded by a newer push' } });
            }
            return run;
        };
        const record = jest.spyOn(h.deps.metrics, 'recordRunState');

        const moved = await transition(h.deps, req, 'regression', { check: { conclusion: 'failure', title: '1 regression' } });

        expect(moved).toBe(false);
        expect(await h.projection.get(req.runId)).toMatchObject({ state: 'superseded', check: { conclusion: 'cancelled' } });
        expect((await h.projection.get(req.runId))!.finishedAt).toBeUndefined();
        const events = (await h.stream.read(req.organizationId, req.runId))?.events ?? [];
        expect(JSON.stringify(events)).not.toContain('regression');
        expect(record).not.toHaveBeenCalled();
    });

    it('a step that died after writing its own terminal state moves again, so the Run still publishes', async () => {
        const h = inMemoryRunDeps();
        await h.projection.upsert(req.runId, { runId: req.runId, organizationId: req.organizationId, state: 'testing' } as any);
        await h.projection.moveState(req.runId, { state: 'regression' });
        const get = h.projection.get.bind(h.projection);
        // The re-run of the step reads the state before the crash.
        h.deps.projection.get = async (id: string) => ({ ...(await get(id))!, state: 'testing' });

        expect(await transition(h.deps, req, 'regression')).toBe(true);
    });
});
