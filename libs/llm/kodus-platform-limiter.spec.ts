/**
 * The shared Kodus platform gate: N orgs on the Kodus provider all draw on
 * ONE upstream account per vendor, so a process-wide cap per upstream must
 * hold across organizations — where the per-org slot limiter cannot.
 */
import type { NormalizedModel } from './byok-config';
import {
    __kodusPlatformLimiterInternals,
    __limiterCacheInternals,
    runWithBYOKLimiter,
} from './byok-limiter';

const slot = (over: Partial<NormalizedModel> = {}): NormalizedModel =>
    ({
        provider: 'kodus',
        apiKey: '',
        model: 'anthropic/claude-sonnet-5',
        ...over,
    }) as NormalizedModel;

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
}

const ENV_KEYS = [
    'API_KODUS_PROVIDER_MAX_CONCURRENT',
    'API_KODUS_PROVIDER_MAX_CONCURRENT_ANTHROPIC',
    'API_KODUS_PROVIDER_RPM',
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    __kodusPlatformLimiterInternals.reset();
    __limiterCacheInternals.cache.clear();
});
afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe('Kodus platform limiter', () => {
    it('caps concurrency ACROSS organizations per upstream', async () => {
        process.env.API_KODUS_PROVIDER_MAX_CONCURRENT = '2';
        const gates = [deferred(), deferred(), deferred()];
        let running = 0;
        let peak = 0;
        const task = (i: number) => async () => {
            running += 1;
            peak = Math.max(peak, running);
            await gates[i].promise;
            running -= 1;
            return i;
        };

        // Three DIFFERENT orgs, no per-org limits at all — only the platform
        // gate can serialize them.
        const runs = [0, 1, 2].map((i) =>
            runWithBYOKLimiter(
                { slot: slot(), organizationId: `org-${i}` },
                task(i),
            ),
        );
        await new Promise((r) => setImmediate(r));
        expect(running).toBe(2);

        gates[0].resolve();
        await runs[0];
        await new Promise((r) => setImmediate(r));
        expect(running).toBe(2); // the third got the freed slot

        gates[1].resolve();
        gates[2].resolve();
        await Promise.all(runs);
        expect(peak).toBe(2);
        expect(__kodusPlatformLimiterInternals.cache.has('kodus::anthropic')).toBe(true);
    });

    it('is keyed per upstream: Anthropic and OpenAI traffic do not share a gate', async () => {
        process.env.API_KODUS_PROVIDER_MAX_CONCURRENT = '1';
        const a = deferred();
        const b = deferred();
        let running = 0;
        const hold = (g: { promise: Promise<void> }) => async () => {
            running += 1;
            await g.promise;
            running -= 1;
        };
        const ra = runWithBYOKLimiter(
            { slot: slot({ model: 'anthropic/claude-sonnet-5' }), organizationId: 'o' },
            hold(a),
        );
        const rb = runWithBYOKLimiter(
            { slot: slot({ model: 'openai/gpt-5.4' }), organizationId: 'o' },
            hold(b),
        );
        await new Promise((r) => setImmediate(r));
        expect(running).toBe(2);
        a.resolve();
        b.resolve();
        await Promise.all([ra, rb]);
        expect([...__kodusPlatformLimiterInternals.cache.keys()].sort()).toEqual([
            'kodus::anthropic',
            'kodus::openai',
        ]);
    });

    it('a per-upstream env override wins over the shared cap', async () => {
        process.env.API_KODUS_PROVIDER_MAX_CONCURRENT = '5';
        process.env.API_KODUS_PROVIDER_MAX_CONCURRENT_ANTHROPIC = '1';
        const g = deferred();
        let running = 0;
        const hold = async () => {
            running += 1;
            await g.promise;
            running -= 1;
        };
        const r1 = runWithBYOKLimiter({ slot: slot(), organizationId: 'a' }, hold);
        const r2 = runWithBYOKLimiter({ slot: slot(), organizationId: 'b' }, hold);
        await new Promise((r) => setImmediate(r));
        expect(running).toBe(1);
        g.resolve();
        await Promise.all([r1, r2]);
    });

    it('no env cap → no platform gate (fast path, nothing cached)', async () => {
        const fn = jest.fn().mockResolvedValue('ok');
        await expect(
            runWithBYOKLimiter({ slot: slot(), organizationId: 'a' }, fn),
        ).resolves.toBe('ok');
        expect(__kodusPlatformLimiterInternals.cache.size).toBe(0);
    });

    it("an org's OWN-key slot never touches the platform gate", async () => {
        process.env.API_KODUS_PROVIDER_MAX_CONCURRENT = '1';
        const fn = jest.fn().mockResolvedValue('ok');
        await runWithBYOKLimiter(
            {
                slot: slot({ provider: 'anthropic', apiKey: 'enc', model: 'claude-sonnet-5' } as any),
                organizationId: 'a',
            },
            fn,
        );
        expect(__kodusPlatformLimiterInternals.cache.size).toBe(0);
    });

    it('composes with the per-org limiter: org cap outside, platform cap inside', async () => {
        process.env.API_KODUS_PROVIDER_MAX_CONCURRENT = '10';
        const g = deferred();
        let running = 0;
        const hold = async () => {
            running += 1;
            await g.promise;
            running -= 1;
        };
        // One org capped at 1 by ITS slot config; the platform allows 10.
        const orgSlot = slot({ maxConcurrentRequests: 1 });
        const r1 = runWithBYOKLimiter({ slot: orgSlot, organizationId: 'a' }, hold);
        const r2 = runWithBYOKLimiter({ slot: orgSlot, organizationId: 'a' }, hold);
        await new Promise((r) => setImmediate(r));
        expect(running).toBe(1);
        g.resolve();
        await Promise.all([r1, r2]);
    });
});
