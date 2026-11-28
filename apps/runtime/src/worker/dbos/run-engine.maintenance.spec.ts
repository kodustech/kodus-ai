import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { DBOS } from '@dbos-inc/dbos-sdk';

import { RunEngineService } from './run-engine.service';
import type { WorkflowHistory, WorkflowRow } from '../../shared/persistence/workflow-retention';
import { InMemoryCommandStore, InMemoryDistributedLocks } from '../../shared/persistence/testing';

// The sweep, the reaper and the retention run once per tick for the whole
// cluster: the replica that takes the maintenance lock does them.
describe('maintenance tick', () => {
    const build = (locks = new InMemoryDistributedLocks(), retention?: () => Promise<number>, workflows?: WorkflowHistory, projection = new InMemoryRunProjectionStore()) => {
        const reap = jest.fn(async () => 0);
        const engine = new RunEngineService(
            { sweeper: false } as any,
            { forRun: () => ({}) as any, forStop: () => ({}) as any, reap },
            projection,
            new RuntimeMetrics(),
            new InMemoryCommandStore(),
            locks,
            undefined,
            retention,
            undefined,
            undefined,
            workflows,
        );
        const sweep = jest.spyOn(engine, 'sweep').mockResolvedValue(undefined);
        return { engine, reap, sweep };
    };

    it('runs sweep, reap and retention when it holds the lock', async () => {
        const retention = jest.fn(async () => 3);
        const { engine, reap, sweep } = build(undefined, retention);
        expect(await engine.maintenanceTick(new Date())).toBe(true);
        expect(sweep).toHaveBeenCalledTimes(1);
        expect(reap).toHaveBeenCalledTimes(1);
        expect(retention).toHaveBeenCalledTimes(1);
        // Retention once an hour, not every tick.
        await engine.maintenanceTick(new Date(Date.now() + 60_000));
        expect(retention).toHaveBeenCalledTimes(1);
    });

    it('a second replica in the same tick does nothing', async () => {
        const locks = new InMemoryDistributedLocks();
        const a = build(locks);
        const b = build(locks);
        let release!: () => void;
        a.sweep.mockImplementation(() => new Promise<void>((ok) => (release = ok)));
        const first = a.engine.maintenanceTick();
        await new Promise((r) => setImmediate(r));
        expect(await b.engine.maintenanceTick()).toBe(false);
        expect(b.sweep).not.toHaveBeenCalled();
        release();
        expect(await first).toBe(true);
    });

    it('a failing tick is reported and does not throw', async () => {
        const { engine, sweep } = build();
        sweep.mockRejectedValue(new Error('db down'));
        expect(await engine.maintenanceTick()).toBe(false);
    });

    it('the hourly retention also deletes old terminal DBOS workflows, never a live Run\'s', async () => {
        const old = Date.now() - 40 * 24 * 3_600_000;
        const rows: WorkflowRow[] = [
            { workflowID: 'done-run', status: 'SUCCESS', createdAt: old },
            { workflowID: 'live-run', status: 'SUCCESS', createdAt: old },
            { workflowID: 'live-run:stop', status: 'SUCCESS', createdAt: old },
        ];
        const deleted: string[] = [];
        const workflows: WorkflowHistory = {
            listTerminal: async (_before, limit, offset) => rows.filter((r) => !deleted.includes(r.workflowID)).slice(offset, offset + limit),
            delete: async (ids) => void deleted.push(...ids),
        };
        const projection = new InMemoryRunProjectionStore();
        jest.spyOn(projection, 'listLive').mockResolvedValue([{ runId: 'live-run', state: 'testing' } as any]);
        const { engine } = build(undefined, async () => 0, workflows, projection);
        expect(await engine.maintenanceTick(new Date())).toBe(true);
        expect(deleted).toEqual(['done-run']);
    });
});

describe('start without durable admission', () => {
    afterEach(() => jest.restoreAllMocks());

    // DBOS's workflow id made a repeated runId return the existing workflow; once retention
    // deletes an old workflow, the terminal projection is what keeps a redelivered request from running again.
    it('a request for a Run already final starts no workflow', async () => {
        const projection = new InMemoryRunProjectionStore();
        jest.spyOn(projection, 'get').mockResolvedValue({ runId: 'r1', organizationId: 'org', state: 'no_regressions' } as any);
        const started = jest.spyOn(DBOS, 'startWorkflow').mockImplementation(() => (async () => ({ workflowID: 'r1' })) as any);
        const engine = new RunEngineService({ sweeper: false } as any, {} as any, projection, new RuntimeMetrics(), new InMemoryCommandStore(), new InMemoryDistributedLocks());
        expect(await engine.start({ runId: 'r1', organizationId: 'org', pullRequest: {} } as any)).toBe('r1');
        expect(started).not.toHaveBeenCalled();
    });
});
