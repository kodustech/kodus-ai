import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { InMemoryDistributedLocks } from '../../shared/locks';
import { InMemoryCommandStore } from '../../shared/pg-command-store';
import { RunEngineService } from './run-engine.service';

// The sweep, the reaper and the retention run once per tick for the whole
// cluster: the replica that takes the maintenance lock does them.
describe('maintenance tick', () => {
    const build = (locks = new InMemoryDistributedLocks(), retention?: () => Promise<number>) => {
        const reap = jest.fn(async () => 0);
        const engine = new RunEngineService(
            { sweeper: false } as any,
            { forRun: () => ({}) as any, forStop: () => ({}) as any, reap },
            new InMemoryRunProjectionStore(),
            new RuntimeMetrics(),
            new InMemoryCommandStore(),
            locks,
            undefined,
            retention,
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
});
