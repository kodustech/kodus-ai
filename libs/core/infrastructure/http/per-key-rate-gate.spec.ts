import {
    __resetRateGatesForTest,
    parkRateGate,
    RateGateWaitExceededError,
    rateGateKey,
    recordRateGateSuccess,
    recordRateLimited,
    runWithRateGate,
} from './per-key-rate-gate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-key-rate-gate', () => {
    beforeEach(() => {
        __resetRateGatesForTest();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('serializes concurrent calls that share a key (single slot)', async () => {
        let active = 0;
        let maxActive = 0;

        const call = () =>
            runWithRateGate('k', { minIntervalMs: 0 }, async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await sleep(20);
                active -= 1;
            });

        await Promise.all([call(), call(), call()]);

        // Never two in flight at once for the same key.
        expect(maxActive).toBe(1);
    });

    it('lets different keys run concurrently', async () => {
        let active = 0;
        let maxActive = 0;

        const call = (key: string) =>
            runWithRateGate(key, { minIntervalMs: 0 }, async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await sleep(20);
                active -= 1;
            });

        await Promise.all([call('a'), call('b')]);

        expect(maxActive).toBe(2);
    });

    it('spaces consecutive call starts by at least minIntervalMs', async () => {
        const starts: number[] = [];

        const call = () =>
            runWithRateGate('k', { minIntervalMs: 50 }, async () => {
                starts.push(Date.now());
            });

        await Promise.all([call(), call(), call()]);

        // Allow a small scheduling tolerance below the nominal interval.
        expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(45);
        expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(45);
    });

    it('parks the key until the Retry-After window clears', async () => {
        // Prime the gate so parkRateGate has state to mutate.
        await runWithRateGate('k', { minIntervalMs: 0 }, async () => undefined);

        const parkMs = 60;
        const parkedFrom = Date.now();
        parkRateGate('k', Date.now() + parkMs);

        const ranAt = await runWithRateGate('k', { minIntervalMs: 0 }, async () =>
            Date.now(),
        );

        expect(ranAt - parkedFrom).toBeGreaterThanOrEqual(parkMs - 5);
    });

    it('only ever extends a park window, never shortens it', async () => {
        await runWithRateGate('k', { minIntervalMs: 0 }, async () => undefined);

        const now = Date.now();
        parkRateGate('k', now + 200);
        parkRateGate('k', now + 10); // shorter — must be ignored

        const ranAt = await runWithRateGate('k', { minIntervalMs: 0 }, async () =>
            Date.now(),
        );

        expect(ranAt - now).toBeGreaterThanOrEqual(195);
    });

    it('derives a stable, non-reversible key per credential', () => {
        const a1 = rateGateKey('bitbucket', 'Basic dXNlcjpwYXNz');
        const a2 = rateGateKey('bitbucket', 'Basic dXNlcjpwYXNz');
        const b = rateGateKey('bitbucket', 'Basic b3RoZXI6c2VjcmV0');

        expect(a1).toBe(a2); // same credential → same bucket
        expect(a1).not.toBe(b); // different credential → different bucket
        expect(a1).not.toContain('dXNlcjpwYXNz'); // raw secret not embedded
        expect(a1.startsWith('bitbucket:')).toBe(true);
    });

    it('rejects a call that would wait past maxWaitMs instead of sleeping', async () => {
        jest.useFakeTimers();
        await runWithRateGate('k', { minIntervalMs: 0 }, async () => undefined);
        parkRateGate('k', Date.now() + 60_000);

        const fn = jest.fn();
        const error = await runWithRateGate(
            'k',
            { minIntervalMs: 0, maxWaitMs: 1_000 },
            fn,
        ).catch((e) => e);

        // Gave up at once, and says how long the key stays parked
        expect(error).toBeInstanceOf(RateGateWaitExceededError);
        expect(error).toMatchObject({
            status: 429,
            name: 'RateGateWaitExceededError',
            key: 'k',
            waitedMs: 0,
            retryAfterMs: 60_000,
        });
        expect(error.message).toBe(
            'Rate gate k: gave up after waiting 0ms (key parked for another 60000ms)',
        );
        expect(fn).not.toHaveBeenCalled();
    });

    it('drains a parked queue at once when every caller has a budget', async () => {
        await runWithRateGate('k', { minIntervalMs: 0 }, async () => undefined);
        parkRateGate('k', Date.now() + 60_000);

        const calls = Array.from({ length: 20 }, () =>
            runWithRateGate(
                'k',
                { minIntervalMs: 0, maxWaitMs: 1_000 },
                async () => 'ran',
            ).catch((e) => e),
        );
        const results = await Promise.all(calls);

        expect(
            results.every((r) => r instanceof RateGateWaitExceededError),
        ).toBe(true);
    });

    it('charges queue time against the budget while the key is rate limited', async () => {
        jest.useFakeTimers();
        recordRateLimited('k', { baseMs: 0, maxMs: 0 });
        const holder = runWithRateGate('k', { minIntervalMs: 0 }, () =>
            sleep(120),
        );
        const queued = runWithRateGate(
            'k',
            { minIntervalMs: 0, maxWaitMs: 50 },
            async () => 'ran',
        ).catch((e) => e);

        await jest.advanceTimersByTimeAsync(120);
        await holder;
        const error = await queued;

        expect(error).toBeInstanceOf(RateGateWaitExceededError);
        // It waited behind the holder; nothing is parked, so no retry delay
        expect(error).toMatchObject({ waitedMs: 120, retryAfterMs: 0 });
    });

    it('never cuts a healthy queue short, however long it waited', async () => {
        const holder = runWithRateGate('k', { minIntervalMs: 0 }, () =>
            sleep(120),
        );
        const queued = runWithRateGate(
            'k',
            { minIntervalMs: 0, maxWaitMs: 50 },
            async () => 'ran',
        );

        await holder;
        await expect(queued).resolves.toBe('ran');
    });

    it('still waits out a park that fits in maxWaitMs', async () => {
        await runWithRateGate('k', { minIntervalMs: 0 }, async () => undefined);
        parkRateGate('k', Date.now() + 50);

        await expect(
            runWithRateGate(
                'k',
                { minIntervalMs: 0, maxWaitMs: 1_000 },
                async () => 'ran',
            ),
        ).resolves.toBe('ran');
    });

    it('doubles the 429 backoff per 429 in a row, capped, and resets on success', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const backoff = { baseMs: 10_000, maxMs: 60_000 };

        expect(
            [1, 2, 3, 4, 5].map(() => recordRateLimited('k', backoff)),
        ).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);

        recordRateGateSuccess('k');
        expect(recordRateLimited('k', backoff)).toBe(10_000);
        // Streaks are per credential
        expect(recordRateLimited('other', backoff)).toBe(10_000);
    });

    it('resetting the streak of a key never seen is a no-op', () => {
        expect(() => recordRateGateSuccess('never-seen')).not.toThrow();
    });

    it('adds at most 20% jitter to the backoff', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.999);

        expect(recordRateLimited('k', { baseMs: 10_000, maxMs: 60_000 })).toBe(
            11_998,
        );
    });
});
