import { SandboxConcurrencyLimiter } from './sandbox-concurrency-limiter';
import { parseLimits } from './sandbox-concurrency-config.service';

describe('SandboxConcurrencyLimiter', () => {
    afterEach(() => jest.useRealTimers());

    it('never blocks when the cap is disabled', async () => {
        const limiter = new SandboxConcurrencyLimiter(60_000);
        const limits = { maxPerWorker: 0, waitMs: 0 };

        for (let i = 0; i < 50; i++) {
            await expect(limiter.acquire(`h${i}`, limits)).resolves.toBe(true);
        }
        expect(limiter.active).toBe(50);
    });

    it('grants up to the cap and refuses immediately with waitMs 0', async () => {
        const limiter = new SandboxConcurrencyLimiter(60_000);
        const limits = { maxPerWorker: 2, waitMs: 0 };

        await expect(limiter.acquire('a', limits)).resolves.toBe(true);
        await expect(limiter.acquire('b', limits)).resolves.toBe(true);
        await expect(limiter.acquire('c', limits)).resolves.toBe(false);
    });

    it('hands a released slot to the oldest waiter', async () => {
        jest.useFakeTimers();
        const limiter = new SandboxConcurrencyLimiter(60_000);
        const limits = { maxPerWorker: 1, waitMs: 30_000 };

        await limiter.acquire('a', limits);
        const second = limiter.acquire('b', limits);
        const third = limiter.acquire('c', limits);
        expect(limiter.waiting).toBe(2);

        limiter.release('a');
        await expect(second).resolves.toBe(true);
        expect(limiter.waiting).toBe(1);

        limiter.release('b');
        await expect(third).resolves.toBe(true);
    });

    it('gives up after waitMs when no slot frees', async () => {
        jest.useFakeTimers();
        const limiter = new SandboxConcurrencyLimiter(60_000);
        const limits = { maxPerWorker: 1, waitMs: 30_000 };

        await limiter.acquire('a', limits);
        const waiting = limiter.acquire('b', limits);

        jest.advanceTimersByTime(30_000);
        await expect(waiting).resolves.toBe(false);
        expect(limiter.waiting).toBe(0);

        // A later release must not hand the slot to the timed-out waiter
        limiter.release('a');
        expect(limiter.active).toBe(0);
    });

    it('drops holders that were never released after staleAfterMs', async () => {
        let now = 0;
        const limiter = new SandboxConcurrencyLimiter(1_000, () => now);
        const limits = { maxPerWorker: 1, waitMs: 0 };

        await limiter.acquire('leaked', limits);
        await expect(limiter.acquire('b', limits)).resolves.toBe(false);

        now = 1_001;
        await expect(limiter.acquire('b', limits)).resolves.toBe(true);
    });

    it('reports each holder it drops as stale', async () => {
        let now = 0;
        const onStale = jest.fn();
        const limiter = new SandboxConcurrencyLimiter(
            1_000,
            () => now,
            onStale,
        );
        const limits = { maxPerWorker: 2, waitMs: 0 };

        await limiter.acquire('leaked', limits);
        now = 1_500;
        await limiter.acquire('fresh', limits);

        expect(onStale).toHaveBeenCalledTimes(1);
        expect(onStale).toHaveBeenCalledWith('leaked', 1_500);
    });
});

describe('parseLimits', () => {
    it('falls back to the uncapped default for a missing value', () => {
        expect(parseLimits(undefined)).toEqual({
            maxPerWorker: 0,
            waitMs: 30_000,
        });
    });

    it('reads numbers and numeric strings, ignoring garbage', () => {
        expect(parseLimits({ maxPerWorker: '6', waitMs: 10_000 })).toEqual({
            maxPerWorker: 6,
            waitMs: 10_000,
        });
        expect(parseLimits({ maxPerWorker: -1, waitMs: 'soon' })).toEqual({
            maxPerWorker: 0,
            waitMs: 30_000,
        });
    });
});
