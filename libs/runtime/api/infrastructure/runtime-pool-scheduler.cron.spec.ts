import { OtelPoolSchedulerMetrics, POOL_SCHEDULER_TICK_METRIC, RuntimePoolSchedulerCron, type PoolSchedulerTickOutcome } from './runtime-pool-scheduler.cron';

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@libs/core/log/logger', () => ({ createLogger: () => logger }));

function setup(opts: { tick?: () => Promise<any>; acquire?: () => Promise<any> } = {}) {
    const release = jest.fn().mockResolvedValue(undefined);
    const pool = { tick: jest.fn(opts.tick ?? (async () => ({ checked: 0 }))) };
    const locks = { acquire: jest.fn(opts.acquire ?? (async () => ({ release }))) };
    const ticks: PoolSchedulerTickOutcome[] = [];
    const cron = new RuntimePoolSchedulerCron(pool as any, locks as any, { recordTick: (o) => ticks.push(o) });
    return { cron, pool, release, ticks };
}

beforeEach(() => jest.clearAllMocks());

describe('RuntimePoolSchedulerCron', () => {
    // A deployment that runs the Runtime (runtime-api-crons-off.spec.ts covers one that does not).
    const saved = process.env.RUNTIME_ENABLED;
    beforeEach(() => {
        process.env.RUNTIME_ENABLED = 'true';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.RUNTIME_ENABLED;
        else process.env.RUNTIME_ENABLED = saved;
    });

    it('counts a tick that ran', async () => {
        const t = setup();
        await t.cron.handleCron();
        expect(t.ticks).toEqual(['ok']);
        expect(t.release).toHaveBeenCalled();
    });

    it('counts a tick that threw, so a tick failing every 5 minutes pages instead of only logging', async () => {
        const t = setup({ tick: async () => Promise.reject(new Error('column e.updated_at does not exist')) });
        await t.cron.handleCron();
        expect(t.ticks).toEqual(['failed']);
        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Runtime pool scheduler: tick failed' }));
        expect(t.release).toHaveBeenCalled();
    });

    it('counts a lock that could not be asked for, and a tick another replica runs', async () => {
        const failed = setup({ acquire: async () => Promise.reject(new Error('db down')) });
        await failed.cron.handleCron();
        expect(failed.ticks).toEqual(['lock_failed']);
        expect(failed.pool.tick).not.toHaveBeenCalled();

        const held = setup({ acquire: async () => null });
        await held.cron.handleCron();
        expect(held.ticks).toEqual(['skipped']);
    });
});

describe('RuntimePoolSchedulerCron template setups', () => {
    const saved = process.env.RUNTIME_ENABLED;
    beforeEach(() => {
        process.env.RUNTIME_ENABLED = 'true';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.RUNTIME_ENABLED;
        else process.env.RUNTIME_ENABLED = saved;
    });

    it('asks for the pending template setups under the same lock, before releasing it, even when the tick failed', async () => {
        const order: string[] = [];
        const templates = { run: jest.fn(async () => (order.push('templates'), { pending: 1, requested: 1, skipped: 0, failed: 0 })) };
        const release = jest.fn(async () => void order.push('release'));
        const cron = new RuntimePoolSchedulerCron({ tick: async () => Promise.reject(new Error('x')) } as any, { acquire: async () => ({ release }) } as any, { recordTick: () => undefined }, templates as any);
        await cron.handleCron();
        expect(order).toEqual(['templates', 'release']);
    });

    it('does not count a template pass that throws as a failed tick', async () => {
        const ticks: string[] = [];
        const cron = new RuntimePoolSchedulerCron({ tick: async () => ({ checked: 0 }) } as any, { acquire: async () => ({ release: async () => undefined }) } as any, { recordTick: (o) => ticks.push(o) }, { run: async () => Promise.reject(new Error('x')) } as any);
        await cron.handleCron();
        expect(ticks).toEqual(['ok']);
    });
});

describe('RuntimePoolSchedulerCron suite baselines', () => {
    const saved = process.env.RUNTIME_ENABLED;
    beforeEach(() => {
        process.env.RUNTIME_ENABLED = 'true';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.RUNTIME_ENABLED;
        else process.env.RUNTIME_ENABLED = saved;
    });

    it('issues the pending baseline suite runs under the same lock, after the template setups and before releasing it', async () => {
        const order: string[] = [];
        const templates = { run: jest.fn(async () => (order.push('templates'), { pending: 0, requested: 0, skipped: 0, failed: 0 })) };
        const baselines = { run: jest.fn(async () => (order.push('baselines'), { pending: 1, requested: 1, skipped: 0, failed: 0 })) };
        const release = jest.fn(async () => void order.push('release'));
        const cron = new RuntimePoolSchedulerCron({ tick: async () => ({ checked: 0 }) } as any, { acquire: async () => ({ release }) } as any, { recordTick: () => undefined }, templates as any, baselines as any);
        await cron.handleCron();
        expect(order).toEqual(['templates', 'baselines', 'release']);
    });

    it('does not count a baseline pass that throws as a failed tick, and still releases the lock', async () => {
        const ticks: string[] = [];
        const release = jest.fn(async () => undefined);
        const cron = new RuntimePoolSchedulerCron({ tick: async () => ({ checked: 0 }) } as any, { acquire: async () => ({ release }) } as any, { recordTick: (o) => ticks.push(o) }, undefined, { run: async () => Promise.reject(new Error('x')) } as any);
        await cron.handleCron();
        expect(ticks).toEqual(['ok']);
        expect(release).toHaveBeenCalled();
    });
});

describe('OtelPoolSchedulerMetrics', () => {
    it('one counter, labelled by outcome', () => {
        const counter = { add: jest.fn() };
        const meter = { createCounter: jest.fn(() => counter) };
        new OtelPoolSchedulerMetrics(meter as any).recordTick('failed');
        expect(meter.createCounter).toHaveBeenCalledWith(POOL_SCHEDULER_TICK_METRIC, expect.anything());
        expect(counter.add).toHaveBeenCalledWith(1, { outcome: 'failed' });
    });
});
