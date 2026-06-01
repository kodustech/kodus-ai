import {
    __resetRateGatesForTest,
    parkRateGate,
    rateGateKey,
    runWithRateGate,
} from './per-key-rate-gate';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('per-key-rate-gate', () => {
    beforeEach(() => {
        __resetRateGatesForTest();
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
});
