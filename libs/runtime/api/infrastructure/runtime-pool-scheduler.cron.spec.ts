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

describe('OtelPoolSchedulerMetrics', () => {
    it('one counter, labelled by outcome', () => {
        const counter = { add: jest.fn() };
        const meter = { createCounter: jest.fn(() => counter) };
        new OtelPoolSchedulerMetrics(meter as any).recordTick('failed');
        expect(meter.createCounter).toHaveBeenCalledWith(POOL_SCHEDULER_TICK_METRIC, expect.anything());
        expect(counter.add).toHaveBeenCalledWith(1, { outcome: 'failed' });
    });
});
