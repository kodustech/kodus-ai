import { SandboxConcurrencyLimiter } from './sandbox-concurrency-limiter';
import {
    parseLimits,
    SandboxConcurrencyConfigService,
} from './sandbox-concurrency-config.service';

describe('SandboxConcurrencyLimiter', () => {
    it('never blocks when the cap is disabled', async () => {
        const limiter = new SandboxConcurrencyLimiter(60_000);

        for (let i = 0; i < 50; i++) {
            await expect(limiter.acquire(`h${i}`, 0)).resolves.toBe(true);
        }
        expect(limiter.active).toBe(50);
    });

    it('queues past the cap instead of refusing, and never gives up on its own', async () => {
        jest.useFakeTimers();
        try {
            const limiter = new SandboxConcurrencyLimiter(24 * 3_600_000);
            await limiter.acquire('a', 1);

            let settled = false;
            const waiting = limiter
                .acquire('b', 1)
                .then((granted) => (settled = granted));

            // An hour later it is still in line, not refused
            await jest.advanceTimersByTimeAsync(3_600_000);
            expect(settled).toBe(false);
            expect(limiter.waiting).toBe(1);

            limiter.release('a');
            await expect(waiting).resolves.toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    it('hands released slots out in arrival order', async () => {
        const limiter = new SandboxConcurrencyLimiter(60_000);
        await limiter.acquire('a', 1);
        const order: string[] = [];
        const b = limiter.acquire('b', 1).then(() => order.push('b'));
        const c = limiter.acquire('c', 1).then(() => order.push('c'));

        limiter.release('a');
        await b;
        limiter.release('b');
        await c;

        expect(order).toEqual(['b', 'c']);
    });

    it('admits waiters at once when the cap is raised', async () => {
        const limiter = new SandboxConcurrencyLimiter(60_000);
        await limiter.acquire('a', 1);
        const b = limiter.acquire('b', 1);
        const c = limiter.acquire('c', 1);

        limiter.setLimit(3);

        await expect(Promise.all([b, c])).resolves.toEqual([true, true]);
        expect(limiter.active).toBe(3);
    });

    it('takes a waiter out of the line on release, without granting it', async () => {
        const limiter = new SandboxConcurrencyLimiter(60_000);
        await limiter.acquire('a', 1);
        const b = limiter.acquire('b', 1);

        limiter.release('b');

        await expect(b).resolves.toBe(false);
        expect(limiter.waiting).toBe(0);
        limiter.release('a');
        expect(limiter.active).toBe(0);
    });

    it('drops holders that were never released after staleAfterMs', async () => {
        let now = 0;
        const onStale = jest.fn();
        const limiter = new SandboxConcurrencyLimiter(
            1_000,
            () => now,
            onStale,
        );
        await limiter.acquire('leaked', 1);
        const next = limiter.acquire('next', 1);

        now = 1_500;
        limiter.setLimit(1);

        await expect(next).resolves.toBe(true);
        expect(onStale).toHaveBeenCalledWith('leaked', 1_500);
    });

    it('still reports a dropped holder when its sink throws, at error level', async () => {
        let now = 0;
        const limiter = new SandboxConcurrencyLimiter(
            1_000,
            () => now,
            () => {
                throw new Error('log sink down');
            },
        );
        const error = jest.fn();
        (limiter as any).logger = { error };

        await limiter.acquire('leaked', 1);
        const next = limiter.acquire('next', 1);
        now = 1_500;
        limiter.setLimit(1);

        await expect(next).resolves.toBe(true);
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: { holderId: 'leaked', heldMs: 1_500 },
            }),
        );
    });
});

describe('parseLimits', () => {
    it('falls back to the uncapped default for a missing value', () => {
        expect(parseLimits(undefined)).toEqual({ maxPerWorker: 0 });
    });

    it('reads numbers and numeric strings, ignoring garbage', () => {
        expect(parseLimits({ maxPerWorker: '6' })).toEqual({
            maxPerWorker: 6,
        });
        expect(parseLimits({ maxPerWorker: -1 })).toEqual({ maxPerWorker: 0 });
    });

    it('takes a value above the ceiling as a typo and falls back to the default', () => {
        expect(parseLimits({ maxPerWorker: 1_000_000 })).toEqual({
            maxPerWorker: 0,
        });
        expect(parseLimits({ maxPerWorker: 100 })).toEqual({
            maxPerWorker: 100,
        });
    });
});

describe('SandboxConcurrencyConfigService', () => {
    afterEach(() => jest.useRealTimers());

    it('retries a failed read within seconds instead of caching it for the TTL', async () => {
        jest.useFakeTimers({ now: 1_000_000 });
        const findByKey = jest
            .fn()
            .mockRejectedValueOnce(new Error('connection reset'))
            .mockResolvedValue({ configValue: { maxPerWorker: 4 } });
        const service = new SandboxConcurrencyConfigService({
            findByKey,
        } as any);
        const warn = jest.fn();
        (service as any).logger = { warn };

        await expect(service.getLimits()).resolves.toEqual({
            maxPerWorker: 0,
        });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ neverRead: true }),
            }),
        );
        // Within the retry window: no second read
        await service.getLimits();
        expect(findByKey).toHaveBeenCalledTimes(1);

        jest.setSystemTime(1_000_000 + 5_000);
        await expect(service.getLimits()).resolves.toEqual({
            maxPerWorker: 4,
        });
        expect(findByKey).toHaveBeenCalledTimes(2);
    });

    it('keeps the last limits it read when a later read fails', async () => {
        jest.useFakeTimers({ now: 1_000_000 });
        const findByKey = jest
            .fn()
            .mockResolvedValueOnce({ configValue: { maxPerWorker: 3 } })
            .mockRejectedValue(new Error('connection reset'));
        const service = new SandboxConcurrencyConfigService({
            findByKey,
        } as any);
        (service as any).logger = { warn: jest.fn() };

        await service.getLimits();
        jest.setSystemTime(1_000_000 + 61_000);

        await expect(service.getLimits()).resolves.toEqual({
            maxPerWorker: 3,
        });
        // The second answer came from a failed re-read, not the cache
        expect(findByKey).toHaveBeenCalledTimes(2);
    });
});
