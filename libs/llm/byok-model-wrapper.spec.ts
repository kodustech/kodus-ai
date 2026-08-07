import { BYOKProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from '@libs/llm/byok-config';

// The tpm gate estimates prompt tokens with the LIFTED shared estimator
// (`@libs/llm/token-estimate`, tiktoken-backed). Mock it so reservoir arithmetic
// is DETERMINISTIC — the estimator itself is proven in token-estimator.spec.ts.
// byok-to-vercel.ts (the reservoir) does NOT import this module, so the mock
// only controls the wrapper's pre-call estimate, never the reservoir math.
jest.mock('@libs/llm/token-estimate', () => ({
    estimateTextTokens: jest.fn(),
}));

import { estimateTextTokens } from '@libs/llm/token-estimate';
import { wrapByokModel } from './byok-model-wrapper';
import { getLimiterForSlot } from './byok-to-vercel';

const estimateMock = estimateTextTokens as unknown as jest.Mock;

// ─── test doubles ─────────────────────────────────────────────────────────────
// Drive the PUBLIC seam: build a minimal LanguageModelV4-shaped inner model and
// call the wrapped model's `doGenerate` (which invokes middleware.wrapGenerate).
// NOT a MockLanguageModelV4 — a plain fake whose doGenerate we control.

// The prompt type the wrapped model's `doGenerate` expects, derived from the
// SDK so the literal `role`/`type` narrow to the required unions.
type Prompt = Parameters<
    ReturnType<typeof wrapByokModel>['doGenerate']
>[0]['prompt'];
const PROMPT: Prompt = [
    { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
];

function makeModel(opts: { usageTotal: number; onStart?: () => void }) {
    const doGenerate = jest.fn(async () => {
        opts.onStart?.();
        return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: 'stop',
            usage: {
                inputTokens: opts.usageTotal,
                outputTokens: 0,
                totalTokens: opts.usageTotal,
            },
            warnings: [],
        };
    });
    return {
        specificationVersion: 'v4',
        provider: 'test-provider',
        modelId: 'test-model',
        supportedUrls: {},
        doGenerate,
        doStream: jest.fn(async () => ({ stream: undefined })),
    } as any;
}

// Unique apiKey per slot → unique limiter cache key → isolated reservoir state.
function tpmSlot(
    apiKey: string,
    opts: {
        tpm?: number;
        rpm?: number;
        maxConcurrentRequests?: number;
        maxOutputTokens?: number;
    } = {},
): NormalizedModel {
    return {
        provider: BYOKProvider.OPENAI,
        apiKey,
        model: 'gpt-4o',
        ...opts,
    } as NormalizedModel;
}

// `wrapByokModel` returns the concrete wrapped model (a `LanguageModelV*`), so
// the tests drive it directly via `.doGenerate` — no cast needed.
function wrap(model: any, slot?: NormalizedModel) {
    return wrapByokModel(model, {
        byokConfig: slot,
        organizationId: 'org-1',
        provider: 'openai',
    });
}

function flushMicrotasks(): Promise<void> {
    return (async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
    })();
}

describe('wrapByokModel — tpm admission gate (fake timers)', () => {
    beforeEach(() => {
        jest.useFakeTimers({ now: 0 });
        estimateMock.mockReset();
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('HOLDS a call whose estimate exceeds the reservoir until it refills, then runs', async () => {
        // capacity = 1000; refill = 1000 tokens/min ⇒ 1 token / 60ms.
        estimateMock.mockReturnValue(900);
        const slot = tpmSlot('cipher-hold', { tpm: 1000 });
        const model = makeModel({ usageTotal: 900 }); // actual == estimate
        const wrapped = wrap(model, slot);

        // Call 1: debits 900 → reservoir 100; reconcile keeps it at 100.
        await wrapped.doGenerate({ prompt: PROMPT });
        expect(model.doGenerate).toHaveBeenCalledTimes(1);

        // Call 2: estimate 900 > reservoir 100 ⇒ HELD (not fired immediately).
        const p2 = wrapped.doGenerate({ prompt: PROMPT });
        Promise.resolve(p2).catch(() => undefined);
        await flushMicrotasks();
        expect(model.doGenerate).toHaveBeenCalledTimes(1); // still held

        // Refill 800 tokens: 800 * 60ms = 48000ms.
        jest.advanceTimersByTime(48_000);
        await flushMicrotasks();
        expect(model.doGenerate).toHaveBeenCalledTimes(2); // released
        await p2;
    });

    it('debits using the tiktoken estimateTextTokens (not a char/4 count)', async () => {
        estimateMock.mockReturnValue(10);
        const slot = tpmSlot('cipher-estimator', { tpm: 1000 });
        const model = makeModel({ usageTotal: 10 });
        const wrapped = wrap(model, slot);

        await wrapped.doGenerate({ prompt: PROMPT });

        // The shared tiktoken estimator was the token source for admission.
        expect(estimateMock).toHaveBeenCalled();
        const arg = estimateMock.mock.calls[0][0];
        expect(typeof arg).toBe('string');
        expect(arg).toContain('hello world'); // derived from params.prompt
    });

    it('reconciles from real post-call usage — an OVER-estimate credits tokens back', async () => {
        // estimate 800, real usage only 200 ⇒ net debit should be 200, not 800.
        estimateMock.mockReturnValue(800);
        const slot = tpmSlot('cipher-over', { tpm: 1000 });
        const model = makeModel({ usageTotal: 200 });
        const wrapped = wrap(model, slot);

        // Call 1: admit (1000→200), reconcile credits +600 ⇒ reservoir 800.
        await wrapped.doGenerate({ prompt: PROMPT });
        expect(model.doGenerate).toHaveBeenCalledTimes(1);

        // Call 2: estimate 800 ≤ reservoir 800 ⇒ admits IMMEDIATELY (no wait).
        // Without post-call reconcile the balance would be 200 and this HANGS.
        await wrapped.doGenerate({ prompt: PROMPT });
        expect(model.doGenerate).toHaveBeenCalledTimes(2);
    });

    it('reconciles from real post-call usage — an UNDER-estimate debits the shortfall', async () => {
        // estimate 200, real usage 900 ⇒ net debit 900, next call must wait.
        estimateMock.mockReturnValue(200);
        const slot = tpmSlot('cipher-under', { tpm: 1000 });
        const model = makeModel({ usageTotal: 900 });
        const wrapped = wrap(model, slot);

        // Call 1: admit (1000→800), reconcile −700 ⇒ reservoir 100.
        await wrapped.doGenerate({ prompt: PROMPT });
        expect(model.doGenerate).toHaveBeenCalledTimes(1);

        // Call 2: estimate 200 > reservoir 100 ⇒ HELD until +100 refills.
        const p2 = wrapped.doGenerate({ prompt: PROMPT });
        Promise.resolve(p2).catch(() => undefined);
        await flushMicrotasks();
        expect(model.doGenerate).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(6_000); // 100 tokens * 60ms
        await flushMicrotasks();
        expect(model.doGenerate).toHaveBeenCalledTimes(2);
        await p2;
    });

    it('composes tpm with rpm and concurrency on ONE per-slot limiter', async () => {
        // tpm huge (never gates) + rpm:60 (1000ms spacing) + concurrency:5.
        estimateMock.mockReturnValue(50);
        const slot = tpmSlot('cipher-compose', {
            tpm: 1_000_000,
            rpm: 60,
            maxConcurrentRequests: 5,
        });
        const starts: number[] = [];
        const model = makeModel({
            usageTotal: 50,
            onStart: () => starts.push(Date.now()),
        });
        const wrapped = wrap(model, slot);

        const p1 = wrapped.doGenerate({ prompt: PROMPT });
        const p2 = wrapped.doGenerate({ prompt: PROMPT });
        Promise.resolve(p1).catch(() => undefined);
        Promise.resolve(p2).catch(() => undefined);

        await flushMicrotasks();
        expect(starts.length).toBe(1); // rpm gate blocks the 2nd start
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        expect(starts.length).toBe(2);
        expect(starts).toEqual([0, 1000]); // rpm still spaces; tpm didn't deadlock
        await Promise.all([p1, p2]);
    });

    it('isolates reservoirs per slot — draining one does not throttle another', async () => {
        estimateMock.mockReturnValue(900);
        const slotA = tpmSlot('cipher-iso-a', { tpm: 1000 });
        const slotB = tpmSlot('cipher-iso-b', { tpm: 1000 });
        const modelA = makeModel({ usageTotal: 900 });
        const modelB = makeModel({ usageTotal: 900 });
        const wrappedA = wrap(modelA, slotA);
        const wrappedB = wrap(modelB, slotB);

        // Drain A near-empty (1000→100).
        await wrappedA.doGenerate({ prompt: PROMPT });
        // A second A call would be held; B is untouched and admits immediately.
        await wrappedB.doGenerate({ prompt: PROMPT });
        expect(modelB.doGenerate).toHaveBeenCalledTimes(1);
    });

    it('does NOT create a new limiter when a non-identity field changes (tpm is not a cache-key identity field)', async () => {
        estimateMock.mockReturnValue(900);
        // Identity-equal slots (same provider/apiKey/baseURL/model); only the
        // NON-identity maxOutputTokens differs → SAME cache key, SAME reservoir.
        const first = tpmSlot('cipher-retune', {
            tpm: 1000,
            maxOutputTokens: 100,
        });
        const second = tpmSlot('cipher-retune', {
            tpm: 1000,
            maxOutputTokens: 200,
        });
        const model = makeModel({ usageTotal: 900 });

        // Call 1 drains the shared reservoir to 100.
        await wrap(model, first).doGenerate({ prompt: PROMPT });
        expect(model.doGenerate).toHaveBeenCalledTimes(1);

        // Call 2 on the identity-equal slot: if a NEW limiter were built it would
        // have a full 1000 and admit; the SHARED reservoir (100) HOLDS it instead.
        estimateMock.mockReturnValue(200);
        const p2 = wrap(model, second).doGenerate({ prompt: PROMPT });
        Promise.resolve(p2).catch(() => undefined);
        await flushMicrotasks();
        expect(model.doGenerate).toHaveBeenCalledTimes(1); // held ⇒ shared limiter

        jest.advanceTimersByTime(6_000); // 100 tokens refill
        await flushMicrotasks();
        expect(model.doGenerate).toHaveBeenCalledTimes(2);
        await p2;
    });
});

describe('wrapByokModel — no-tpm path unchanged (behaves as 05-01)', () => {
    beforeEach(() => estimateMock.mockReset());

    it('a slot with NO tpm skips estimation and reconcile entirely', async () => {
        estimateMock.mockReturnValue(999);
        const slot = tpmSlot('cipher-notpm', { maxConcurrentRequests: 1 });
        const model = makeModel({ usageTotal: 500 });
        const wrapped = wrap(model, slot);

        const result: any = await wrapped.doGenerate({ prompt: PROMPT });

        expect(result.usage.totalTokens).toBe(500);
        expect(model.doGenerate).toHaveBeenCalledTimes(1);
        // No tpm ⇒ zero estimation overhead: the estimator is never called.
        expect(estimateMock).not.toHaveBeenCalled();
    });

    it('a bare slot (no concurrency/rpm/tpm) runs via the limiter fast path', async () => {
        estimateMock.mockReturnValue(999);
        const slot = tpmSlot('cipher-bare');
        const model = makeModel({ usageTotal: 42 });
        const wrapped = wrap(model, slot);

        const result: any = await wrapped.doGenerate({ prompt: PROMPT });
        expect(result.usage.totalTokens).toBe(42);
        expect(estimateMock).not.toHaveBeenCalled();
    });
});

// ─── cooldown arming (429-armed) through the PUBLIC seam ─────────────────────
// The wrapper catch classifies the provider error and — ONLY on a RATE_LIMIT
// (429-rate) and when the slot carries cooldownMs — arms the slot's limiter
// cooldown before rethrowing. A QUOTA_EXCEEDED (429-billing) or TRANSIENT
// (5xx/network) NEVER arms. Arming is a DELAY, never a retry: the reporter and
// the rethrow are untouched.

function makeFailingModel(err: unknown) {
    return {
        specificationVersion: 'v4',
        provider: 'test-provider',
        modelId: 'test-model',
        supportedUrls: {},
        doGenerate: jest.fn(async () => {
            throw err;
        }),
        doStream: jest.fn(async () => ({ stream: undefined })),
    } as any;
}

function cooldownSlot(apiKey: string, cooldownMs?: number): NormalizedModel {
    return {
        provider: BYOKProvider.OPENAI,
        apiKey,
        model: 'gpt-4o',
        ...(cooldownMs ? { cooldownMs } : {}),
    } as NormalizedModel;
}

describe('wrapByokModel — cooldown armed on classified RATE_LIMIT only', () => {
    beforeEach(() => estimateMock.mockReset());

    it('arms the slot cooldown on a 429 RATE_LIMIT (rate, not quota)', async () => {
        const slot = cooldownSlot('cipher-arm-rate', 60_000);
        const err: any = new Error('rate limit exceeded, too many requests');
        err.status = 429;
        const wrapped = wrap(makeFailingModel(err), slot);

        await expect(
            wrapped.doGenerate({ prompt: PROMPT }),
        ).rejects.toThrow('rate limit exceeded');

        expect(getLimiterForSlot({ slot, organizationId: 'org-1' })!.isInCooldown()).toBe(true);
    });

    it('does NOT arm on a 429 QUOTA_EXCEEDED (billing)', async () => {
        const slot = cooldownSlot('cipher-arm-quota', 60_000);
        const err: any = new Error('You exceeded your current quota, billing');
        err.status = 429;
        const wrapped = wrap(makeFailingModel(err), slot);

        await expect(
            wrapped.doGenerate({ prompt: PROMPT }),
        ).rejects.toThrow('quota');

        expect(getLimiterForSlot({ slot, organizationId: 'org-1' })!.isInCooldown()).toBe(false);
    });

    it('does NOT arm on a TRANSIENT (5xx) failure', async () => {
        const slot = cooldownSlot('cipher-arm-transient', 60_000);
        const err: any = new Error('service unavailable');
        err.status = 503;
        const wrapped = wrap(makeFailingModel(err), slot);

        await expect(
            wrapped.doGenerate({ prompt: PROMPT }),
        ).rejects.toThrow('service unavailable');

        expect(getLimiterForSlot({ slot, organizationId: 'org-1' })!.isInCooldown()).toBe(false);
    });

    it('a RATE_LIMIT on a slot WITHOUT cooldownMs never arms (opt-in)', async () => {
        // No cooldownMs, but keep a limiter reachable via a concurrency gate.
        const slot = {
            provider: BYOKProvider.OPENAI,
            apiKey: 'cipher-arm-nocd',
            model: 'gpt-4o',
            maxConcurrentRequests: 1,
        } as NormalizedModel;
        const err: any = new Error('rate limit exceeded');
        err.status = 429;
        const wrapped = wrap(makeFailingModel(err), slot);

        await expect(
            wrapped.doGenerate({ prompt: PROMPT }),
        ).rejects.toThrow('rate limit');

        expect(getLimiterForSlot({ slot, organizationId: 'org-1' })!.isInCooldown()).toBe(false);
    });

    it('arming emits no key material to any console sink', async () => {
        const sinks = ['log', 'warn', 'error', 'info', 'debug'] as const;
        const spies = sinks.map((s) =>
            jest.spyOn(console, s).mockImplementation(() => undefined),
        );
        const secret = 'cipher-arm-secret-must-not-log';
        const slot = cooldownSlot(secret, 60_000);
        const err: any = new Error('rate limit exceeded');
        err.status = 429;
        const wrapped = wrap(makeFailingModel(err), slot);
        try {
            await expect(
                wrapped.doGenerate({ prompt: PROMPT }),
            ).rejects.toThrow('rate limit');
            for (const spy of spies) {
                for (const call of spy.mock.calls) {
                    expect(JSON.stringify(call)).not.toContain(secret);
                }
            }
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
    });
});

describe('wrapByokModel — secret hygiene on the tpm path', () => {
    beforeEach(() => estimateMock.mockReset());

    it('emits no plaintext/ciphertext key material to any console sink', async () => {
        estimateMock.mockReturnValue(10);
        const sinks = ['log', 'warn', 'error', 'info', 'debug'] as const;
        const spies = sinks.map((s) =>
            jest.spyOn(console, s).mockImplementation(() => undefined),
        );
        const secret = 'cipher-secret-must-not-log';
        const slot = tpmSlot(secret, { tpm: 1000 });
        const model = makeModel({ usageTotal: 10 });
        const wrapped = wrap(model, slot);
        try {
            await wrapped.doGenerate({ prompt: PROMPT });
            for (const spy of spies) {
                for (const call of spy.mock.calls) {
                    expect(JSON.stringify(call)).not.toContain(secret);
                }
            }
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
    });
});
