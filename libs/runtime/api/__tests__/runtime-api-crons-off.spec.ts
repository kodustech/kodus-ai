import { RuntimePoolSchedulerCron } from '../infrastructure/runtime-pool-scheduler.cron';
import { RuntimePullRequestSessionSweepCron } from '../infrastructure/runtime-pr-session-sweep.cron';
import { RuntimeProductRetentionCron } from '../infrastructure/runtime-product-retention.cron';

// The API imports the Runtime module on every deployment. A deployment that
// does not run the Runtime (RUNTIME_ENABLED off, the worker's own switch) runs
// none of its crons: no lock, no read, no error line every tick.
describe('the Runtime crons of the API', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    const crons = () => {
        const locks = { acquire: jest.fn(async () => ({ release: async () => undefined })) };
        const sweep = { run: jest.fn(async () => ({ checked: 0, closed: 0, open: 0, unknown: 0 })) };
        const pool = { tick: jest.fn(async () => ({ checked: 0 })) };
        return {
            locks,
            sweep,
            pool,
            sweepCron: new RuntimePullRequestSessionSweepCron(sweep as any, locks as any),
            poolCron: new RuntimePoolSchedulerCron(pool as any, locks as any, { recordTick: () => undefined }),
            retentionCron: new RuntimeProductRetentionCron({ query: jest.fn(async () => []) } as any, locks as any),
        };
    };

    it('do nothing with the Runtime off', async () => {
        process.env.RUNTIME_ENABLED = 'false';
        const t = crons();
        await t.sweepCron.handleCron();
        await t.poolCron.handleCron();
        await t.retentionCron.handleCron();
        expect(t.locks.acquire).not.toHaveBeenCalled();
        expect(t.sweep.run).not.toHaveBeenCalled();
        expect(t.pool.tick).not.toHaveBeenCalled();
    });

    it('run with the Runtime on', async () => {
        process.env.RUNTIME_ENABLED = 'true';
        const t = crons();
        await t.sweepCron.handleCron();
        await t.poolCron.handleCron();
        expect(t.sweep.run).toHaveBeenCalledTimes(1);
        expect(t.pool.tick).toHaveBeenCalledTimes(1);
    });
});
