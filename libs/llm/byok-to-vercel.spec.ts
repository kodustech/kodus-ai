import { BYOKProvider } from '@kodus/kodus-common/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';

// Capture which Vertex SDK factory each model id routes to. Mock factories
// are hoisted above module-scope consts, so define the jest.fn inside the
// factory and pull the references out via the mocked imports below. The
// inner factory (the value createVertex/createVertexAnthropic returns) is
// what's actually invoked with the model id, so we tag its return value.
jest.mock('@ai-sdk/google-vertex', () => ({
    createVertex: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-gemini',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/google-vertex/anthropic', () => ({
    createVertexAnthropic: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'vertex-anthropic',
            modelId,
            settings,
        })),
    ),
}));
// decrypt is identity in tests: the apiKey we pass IS the base64 SA JSON.
jest.mock('@libs/common/utils/crypto', () => ({ decrypt: (v: string) => v }));
// Tag the OpenAI SDK factories so we can assert the registry-routed openai /
// openai_compatible cases reproduce the old inline construction (Phase 1 tracer).
jest.mock('@ai-sdk/openai', () => ({
    createOpenAI: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({ sdk: 'openai', modelId, settings })),
    ),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({
            sdk: 'openai-compatible',
            modelId,
            settings,
        })),
    ),
}));
jest.mock('@ai-sdk/google', () => ({
    createGoogleGenerativeAI: jest.fn((settings: unknown) =>
        jest.fn((modelId: string) => ({ sdk: 'google', modelId, settings })),
    ),
}));
// O3: the reliability limiter emits a lightweight structured signal through the
// repo's createLogger. Mock it so a spy can assert the throttle/cooldown/
// queue-timeout signals fire with {provider, model, reason, waitMs} and NEVER a
// key. `mock`-prefixed so jest's hoist allows the factory to reference it.
const mockLoggerRecord = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    // Defer the spy reference so the factory (run at module-load, before the
    // `const mockLoggerRecord` initializes) doesn't hit its TDZ. Each method
    // forwards lazily at call time (test runtime), when the spy exists.
    createLogger: () => ({
        log: (...a: unknown[]) => mockLoggerRecord(...a),
        debug: (...a: unknown[]) => mockLoggerRecord(...a),
        info: (...a: unknown[]) => mockLoggerRecord(...a),
        warn: (...a: unknown[]) => mockLoggerRecord(...a),
        error: (...a: unknown[]) => mockLoggerRecord(...a),
    }),
}));

import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
    buildModelFromSlot,
    getModelName,
    runWithBYOKLimiter,
    getLimiterForSlot,
    __limiterCacheInternals,
} from './byok-to-vercel';

const createVertexMock = createVertex as unknown as jest.Mock;
const createVertexAnthropicMock = createVertexAnthropic as unknown as jest.Mock;
const createOpenAIMock = createOpenAI as unknown as jest.Mock;
const createOpenAICompatibleMock = createOpenAICompatible as unknown as jest.Mock;

const SA_JSON_B64 = Buffer.from(
    JSON.stringify({
        type: 'service_account',
        project_id: 'my-proj',
        client_email: 'sa@my-proj.iam.gserviceaccount.com',
    }),
).toString('base64');

// v2-native: buildModelFromSlot takes ONE resolved slot (NormalizedModel), never
// a legacy `{main,fallback}` carrier. These helpers build a plain slot.
function vertexSlot(model: string, vertexLocation?: string): NormalizedModel {
    return {
        provider: BYOKProvider.GOOGLE_VERTEX,
        apiKey: SA_JSON_B64,
        model,
        vertexLocation,
    } as NormalizedModel;
}

describe('buildModelFromSlot — Google Vertex protocol routing (resolved slot)', () => {
    beforeEach(() => {
        createVertexMock.mockClear();
        createVertexAnthropicMock.mockClear();
    });

    it('routes a claude-* model id through createVertexAnthropic (Anthropic protocol)', () => {
        const result: any = buildModelFromSlot(
            vertexSlot('claude-3-5-sonnet-v2@20241022', 'us-east5'),
        );

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('vertex-anthropic');
        expect(result.modelId).toBe('claude-3-5-sonnet-v2@20241022');
        // SA project + region flow through to the provider settings.
        expect(createVertexAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({ project: 'my-proj', location: 'us-east5' }),
        );
    });

    it('accepts a raw (non-base64) SA JSON and still routes claude-* to Vertex Anthropic', () => {
        const rawJsonSlot = {
            provider: BYOKProvider.GOOGLE_VERTEX,
            apiKey: JSON.stringify({
                type: 'service_account',
                project_id: 'my-proj',
                client_email: 'sa@my-proj.iam.gserviceaccount.com',
            }),
            model: 'claude-opus-4-8',
            vertexLocation: 'global',
        } as NormalizedModel;

        const result: any = buildModelFromSlot(rawJsonSlot);

        expect(createVertexAnthropicMock).toHaveBeenCalledTimes(1);
        expect(createVertexMock).not.toHaveBeenCalled();
        expect(result.modelId).toBe('claude-opus-4-8');
        expect(createVertexAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({ project: 'my-proj', location: 'global' }),
        );
    });

    it('routes a gemini-* model id through createVertex (Gemini protocol)', () => {
        const result: any = buildModelFromSlot(vertexSlot('gemini-2.5-pro'));

        expect(createVertexMock).toHaveBeenCalledTimes(1);
        expect(createVertexAnthropicMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('vertex-gemini');
        expect(result.modelId).toBe('gemini-2.5-pro');
        // No vertexLocation → defaults to the global endpoint.
        expect(createVertexMock).toHaveBeenCalledWith(
            expect.objectContaining({
                project: 'my-proj',
                location: 'global',
            }),
        );
    });
});

// Phase 1 tracer: OPENAI + OPENAI_COMPATIBLE resolve through the provider
// REGISTRY (libs/llm/providers/openai.module). These assert the registry-routed
// build reproduces the OLD inline construction exactly (same factory, same args,
// same json_schema gate) — the no-regression guarantee for the ported provider.
describe('buildModelFromSlot — OpenAI registry routing (resolved slot)', () => {
    beforeEach(() => {
        createOpenAIMock.mockClear();
        createOpenAICompatibleMock.mockClear();
    });

    it('routes provider "openai" through createOpenAI with the decrypted key and no baseURL', () => {
        const result: any = buildModelFromSlot({
            provider: BYOKProvider.OPENAI,
            apiKey: 'sk-plain',
            model: 'gpt-4o',
        } as NormalizedModel);

        expect(createOpenAIMock).toHaveBeenCalledTimes(1);
        expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
        expect(result.sdk).toBe('openai');
        expect(result.modelId).toBe('gpt-4o');
        expect(createOpenAIMock).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'sk-plain' }),
        );
        // No baseURL key when the slot omits it (native SDK default).
        expect(createOpenAIMock.mock.calls[0][0]).not.toHaveProperty('baseURL');
    });

    it('routes "openai_compatible" through createOpenAICompatible; the :8000 gate enables structured outputs when opted in', () => {
        const result: any = buildModelFromSlot(
            {
                provider: BYOKProvider.OPENAI_COMPATIBLE,
                apiKey: 'sk-compat',
                model: 'kimi-k2.7-code',
                baseURL: 'https://host:8000/v1',
            } as NormalizedModel,
            { structuredOutputs: true },
        );

        expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
        expect(result.sdk).toBe('openai-compatible');
        expect(result.modelId).toBe('kimi-k2.7-code');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'openai-compatible',
                apiKey: 'sk-compat',
                baseURL: 'https://host:8000/v1',
                supportsStructuredOutputs: true,
            }),
        );
    });

    it('openai_compatible: structured outputs stay OFF without the per-call opt-in, even on a :8000 base', () => {
        buildModelFromSlot({
            provider: BYOKProvider.OPENAI_COMPATIBLE,
            apiKey: 'sk-compat',
            model: 'kimi-k2.7-code',
            baseURL: 'https://host:8000/v1',
        } as NormalizedModel);

        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({ supportsStructuredOutputs: false }),
        );
    });
});

// v2-native env/managed default path: a `undefined` slot is the no-BYOK path
// (managed org / self-host env), NOT a `.main`/`.fallback` read.
describe('buildModelFromSlot — env/managed default (undefined slot)', () => {
    const prevEnvMode = process.env.API_LLM_PROVIDER_MODEL;
    const prevMoonshot = process.env.API_MOONSHOT_API_KEY;

    beforeEach(() => {
        createOpenAICompatibleMock.mockClear();
        delete process.env.API_LLM_PROVIDER_MODEL;
        process.env.API_MOONSHOT_API_KEY = 'ms-key';
    });

    afterAll(() => {
        if (prevEnvMode === undefined) delete process.env.API_LLM_PROVIDER_MODEL;
        else process.env.API_LLM_PROVIDER_MODEL = prevEnvMode;
        if (prevMoonshot === undefined) delete process.env.API_MOONSHOT_API_KEY;
        else process.env.API_MOONSHOT_API_KEY = prevMoonshot;
    });

    it('no slot + auto env → the managed Kimi default (kimi-k2.7-code via Moonshot)', () => {
        const result: any = buildModelFromSlot(undefined);

        expect(result.modelId).toBe('kimi-k2.7-code');
        expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'moonshot' }),
        );
    });

    it('no slot + defaultModelOverride → the overridden default model id', () => {
        const result: any = buildModelFromSlot(undefined, {}, 'kimi-k2.7-code');
        expect(result.modelId).toBe('kimi-k2.7-code');
    });
});

describe('getModelName — resolved slot vs env default', () => {
    const prevEnvMode = process.env.API_LLM_PROVIDER_MODEL;

    beforeEach(() => {
        delete process.env.API_LLM_PROVIDER_MODEL;
    });

    afterAll(() => {
        if (prevEnvMode === undefined) delete process.env.API_LLM_PROVIDER_MODEL;
        else process.env.API_LLM_PROVIDER_MODEL = prevEnvMode;
    });

    it('derives `${provider}:${model}` from a single resolved slot', () => {
        expect(
            getModelName({
                provider: BYOKProvider.OPENAI,
                apiKey: 'sk-x',
                model: 'gpt-4o',
            } as NormalizedModel),
        ).toBe('openai:gpt-4o');
    });

    it('undefined slot + auto env → the managed default model id', () => {
        expect(getModelName(undefined)).toBe('kimi-k2.7-code');
    });

    it('undefined slot preserves the self-host env-mode name branch', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gemini-2.5-pro';
        process.env.API_VERTEX_AI_API_KEY = 'sa';
        try {
            expect(getModelName(undefined)).toBe('google_vertex:gemini-2.5-pro');
        } finally {
            delete process.env.API_VERTEX_AI_API_KEY;
        }
    });

    it('undefined slot + defaultModelOverride → the overridden name', () => {
        expect(getModelName(undefined, 'gemini-2.5-flash')).toBe(
            'gemini-2.5-flash',
        );
    });
});

// ─── rpm min-interval gate through the PUBLIC runWithBYOKLimiter seam ─────────
// These drive the exact entry point `wrapByokModel` calls
// (byok-model-wrapper.ts:76-85) — never the private limiter class — with jest
// fake timers to assert call SPACING. rpm is a v2 config field (sibling to
// maxConcurrentRequests) carried config → NormalizedModel slot → limiter.

function flushMicrotasks(): Promise<void> {
    return (async () => {
        // Several microtask hops per task: Promise.resolve → run → then → finally.
        for (let i = 0; i < 8; i++) await Promise.resolve();
    })();
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// Unique apiKey per slot → unique limiter cache key (the module limiterCache is
// keyed on slot identity), so distinct tests never share limiter state. `rpm`
// and `maxConcurrentRequests` are plain numbers; apiKey stays ciphertext.
function rateSlot(
    apiKey: string,
    opts: {
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

describe('runWithBYOKLimiter — rpm min-interval gate (fake timers)', () => {
    beforeEach(() => {
        jest.useFakeTimers({ now: 0 });
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('spaces 3 rpm:60 calls at ~0/1000/2000ms — an rpm-only slot STARTS (never hangs)', async () => {
        // 60000 / 60 = 1000ms min-interval; NO concurrency cap on this slot.
        const slot = rateSlot('cipher-rpm-only', { rpm: 60 });
        const starts: number[] = [];
        const fn = () => {
            starts.push(Date.now());
            return Promise.resolve('ok');
        };

        void runWithBYOKLimiter({ slot }, fn);
        void runWithBYOKLimiter({ slot }, fn);
        void runWithBYOKLimiter({ slot }, fn);

        await flushMicrotasks();
        // Infinity-concurrency fix: with no concurrency cap the drain gate must
        // treat concurrency as unbounded, so the FIRST rpm-only call starts.
        // (A `0 < undefined` gate would hang all three to the queue timeout.)
        expect(starts.length).toBe(1);

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        expect(starts.length).toBe(2);

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        expect(starts.length).toBe(3);

        // Spacing is exactly the min-interval, not simultaneous at t=0.
        expect(starts).toEqual([0, 1000, 2000]);
    });

    it('composes rpm with maxConcurrentRequests on ONE limiter (both gates active)', async () => {
        const slot = rateSlot('cipher-compose', {
            rpm: 60,
            maxConcurrentRequests: 2,
        });
        const starts: number[] = [];
        const gates = [
            deferred<string>(),
            deferred<string>(),
            deferred<string>(),
        ];
        let i = 0;
        const fn = () => {
            const g = gates[i++];
            starts.push(Date.now());
            return g.promise; // blocks until explicitly resolved
        };

        const ps = [
            runWithBYOKLimiter({ slot }, fn),
            runWithBYOKLimiter({ slot }, fn),
            runWithBYOKLimiter({ slot }, fn),
        ];
        ps.forEach((p) => p.catch(() => undefined));

        await flushMicrotasks();
        // rpm gate blocks the 2nd start even though concurrency has room for 2.
        expect(starts.length).toBe(1);

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        // Rate window opened → 2nd starts (concurrency 2 admits it while #1 blocks).
        expect(starts.length).toBe(2);

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        // Concurrency gate now blocks the 3rd: #1 and #2 are both still in flight.
        expect(starts.length).toBe(2);

        // Freeing a slot lets the 3rd through (rate window is already open).
        gates[0].resolve('done');
        await flushMicrotasks();
        expect(starts.length).toBe(3);
        expect(starts).toEqual([0, 1000, 2000]);

        gates[1].resolve('done');
        gates[2].resolve('done');
        await flushMicrotasks();
    });

    it('an unrelated config edit re-tunes the cached limiter (rate state survives — Pitfall 4)', async () => {
        // Identity-equal slots (same provider/apiKey/baseURL/model); only the
        // NON-identity maxOutputTokens differs → same cache key, same limiter.
        const first = rateSlot('cipher-retune', {
            rpm: 60,
            maxOutputTokens: 100,
        });
        const second = rateSlot('cipher-retune', {
            rpm: 60,
            maxOutputTokens: 200,
        });
        const starts: number[] = [];
        const fn = () => {
            starts.push(Date.now());
            return Promise.resolve('ok');
        };

        void runWithBYOKLimiter({ slot: first }, fn);
        await flushMicrotasks();
        expect(starts.length).toBe(1); // first fired at t=0, rate window now open

        // A config edit on an UNRELATED field must NOT reset the in-flight rate
        // window by constructing a fresh limiter — it re-tunes the cached one.
        void runWithBYOKLimiter({ slot: second }, fn);
        await flushMicrotasks();
        expect(starts.length).toBe(1); // still gated by the SAME limiter's window

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        expect(starts.length).toBe(2);
    });

    it('isolates limiters per slot — different identity does NOT cross-throttle', async () => {
        const slotA = rateSlot('cipher-iso-a', { rpm: 60 });
        const slotB = rateSlot('cipher-iso-b', { rpm: 60 });
        const a: number[] = [];
        const b: number[] = [];
        const fnA = () => {
            a.push(Date.now());
            return Promise.resolve('a');
        };
        const fnB = () => {
            b.push(Date.now());
            return Promise.resolve('b');
        };

        void runWithBYOKLimiter({ slot: slotA }, fnA);
        void runWithBYOKLimiter({ slot: slotA }, fnA);
        void runWithBYOKLimiter({ slot: slotB }, fnB);
        void runWithBYOKLimiter({ slot: slotB }, fnB);

        await flushMicrotasks();
        // Each slot's first call starts immediately — A never throttles B.
        expect(a.length).toBe(1);
        expect(b.length).toBe(1);

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();
        // Two calls for the SAME slot share ONE limiter and release after 1000ms.
        expect(a.length).toBe(2);
        expect(b.length).toBe(2);
    });

    it('rpm path emits no key material to any console sink', async () => {
        const sinks = ['log', 'warn', 'error', 'info', 'debug'] as const;
        const spies = sinks.map((s) =>
            jest.spyOn(console, s).mockImplementation(() => undefined),
        );
        const secret = 'cipher-secret-must-not-log';
        const slot = rateSlot(secret, { rpm: 60 });
        try {
            void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
            void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
            await flushMicrotasks();
            jest.advanceTimersByTime(1000);
            await flushMicrotasks();

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

// ─── cooldown gate (429-armed) through the PUBLIC seam ───────────────────────
// A slot carrying `cooldownMs` enters the limiter path so a limiter is cached
// and reachable via getLimiterForSlot. armCooldown() DELAYS new admissions
// until the window passes; isInCooldown() is the predicate the retry owner
// (structured-review-call) consults. Arming is a DELAY, never a retry.

function cooldownSlot(
    apiKey: string,
    opts: { cooldownMs?: number; rpm?: number; tpm?: number } = {},
): NormalizedModel {
    return {
        provider: BYOKProvider.OPENAI,
        apiKey,
        model: 'gpt-4o',
        ...opts,
    } as NormalizedModel;
}

describe('runWithBYOKLimiter — cooldown gate (fake timers)', () => {
    beforeEach(() => {
        jest.useFakeTimers({ now: 0 });
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('a cooldownMs-only slot enters the limiter path (limiter created & cached)', async () => {
        const slot = cooldownSlot('cipher-cd-only', { cooldownMs: 1000 });
        // No limiter before the first admission.
        expect(getLimiterForSlot({ slot })).toBeNull();

        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        await flushMicrotasks();

        // A cooldown-capable slot must NOT fast-path — the limiter now exists so
        // the wrapper catch can arm it and the retry owner can query it.
        expect(getLimiterForSlot({ slot })).not.toBeNull();
    });

    it('armCooldown HOLDS new admissions until the window expires, then drains', async () => {
        const slot = cooldownSlot('cipher-cd-hold', { cooldownMs: 5000 });
        const starts: number[] = [];
        const fn = () => {
            starts.push(Date.now());
            return Promise.resolve('ok');
        };

        // First call primes/caches the limiter and starts immediately (not armed).
        void runWithBYOKLimiter({ slot }, fn);
        await flushMicrotasks();
        expect(starts.length).toBe(1);

        // Arm the slot's cooldown (as the wrapper catch would on a 429).
        getLimiterForSlot({ slot })!.armCooldown(5000);

        // A task queued during cooldown is HELD (never fired immediately).
        void runWithBYOKLimiter({ slot }, fn);
        await flushMicrotasks();
        expect(starts.length).toBe(1);

        // Not yet — window still open.
        jest.advanceTimersByTime(4999);
        await flushMicrotasks();
        expect(starts.length).toBe(1);

        // Window passes → the held task drains.
        jest.advanceTimersByTime(1);
        await flushMicrotasks();
        expect(starts.length).toBe(2);
    });

    it('isInCooldown() reflects arm → in-window → expiry', async () => {
        const slot = cooldownSlot('cipher-cd-pred', { cooldownMs: 3000 });
        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        await flushMicrotasks();

        const limiter = getLimiterForSlot({ slot })!;
        expect(limiter.isInCooldown()).toBe(false);

        limiter.armCooldown(3000);
        expect(limiter.isInCooldown()).toBe(true);

        jest.advanceTimersByTime(2999);
        expect(limiter.isInCooldown()).toBe(true);

        jest.advanceTimersByTime(1);
        expect(limiter.isInCooldown()).toBe(false);
    });

    it('coexists with rpm — arming cooldown does NOT reset the rpm window (Pitfall 4)', async () => {
        // rpm:60 → 1000ms min-interval; cooldown 500ms is SHORTER than the rpm window.
        const slot = cooldownSlot('cipher-cd-rpm', { rpm: 60, cooldownMs: 500 });
        const starts: number[] = [];
        const fn = () => {
            starts.push(Date.now());
            return Promise.resolve('ok');
        };

        void runWithBYOKLimiter({ slot }, fn);
        await flushMicrotasks();
        expect(starts).toEqual([0]); // fired at t=0; rpm window now open until 1000

        // Arm a 500ms cooldown, then queue a 2nd task.
        getLimiterForSlot({ slot })!.armCooldown(500);
        void runWithBYOKLimiter({ slot }, fn);
        await flushMicrotasks();
        expect(starts.length).toBe(1);

        // Cooldown expires at 500, but the rpm min-interval (1000) STILL holds —
        // arming did not reset lastStartAt, so the 2nd start waits for the rpm window.
        jest.advanceTimersByTime(500);
        await flushMicrotasks();
        expect(starts.length).toBe(1);

        jest.advanceTimersByTime(500);
        await flushMicrotasks();
        expect(starts).toEqual([0, 1000]);
    });

    it('a slot with no cooldownMs never arms (isInCooldown stays false — behaves as 05-02)', async () => {
        const slot = cooldownSlot('cipher-cd-none', { rpm: 60 });
        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        await flushMicrotasks();
        expect(getLimiterForSlot({ slot })!.isInCooldown()).toBe(false);
    });

    it('cooldown path emits no key material to any console sink', async () => {
        const sinks = ['log', 'warn', 'error', 'info', 'debug'] as const;
        const spies = sinks.map((s) =>
            jest.spyOn(console, s).mockImplementation(() => undefined),
        );
        const secret = 'cipher-cd-secret-must-not-log';
        const slot = cooldownSlot(secret, { cooldownMs: 1000 });
        try {
            void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
            await flushMicrotasks();
            getLimiterForSlot({ slot })!.armCooldown(1000);
            void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
            await flushMicrotasks();
            jest.advanceTimersByTime(1000);
            await flushMicrotasks();

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

describe('runWithBYOKLimiter — fast path (no rpm + no concurrency)', () => {
    it('returns fn() directly and invokes it synchronously (no limiter, no queue)', async () => {
        const slot = rateSlot('cipher-fastpath'); // neither rpm nor concurrency
        let calledSync = false;
        const fn = () => {
            calledSync = true;
            return Promise.resolve('R');
        };

        const p = runWithBYOKLimiter({ slot }, fn);
        // Fast path invokes fn synchronously; the limiter path defers to a
        // microtask, so synchronous invocation proves NO limiter was entered.
        expect(calledSync).toBe(true);
        await expect(p).resolves.toBe('R');
    });
});

// tpm-carrying slot for reservoir tests. Unique apiKey → unique limiter.
function tpmSlot(
    apiKey: string,
    opts: {
        tpm?: number;
        rpm?: number;
        maxConcurrentRequests?: number;
    } = {},
): NormalizedModel {
    return {
        provider: BYOKProvider.OPENAI,
        apiKey,
        model: 'gpt-4o',
        ...opts,
    } as NormalizedModel;
}

// ─── P1: tpm reservoir credits back FAILED calls (fake timers) ────────────────
// The admission gate debits the full pre-call estimate. On the success path
// reconcileReservoir corrects estimate→actual; on the FAILURE path the estimate
// must be credited back (a 429/timeout/network failure consumed ~0 tokens).
// Without the credit-back a provider outage of N failing calls permanently
// drains the reservoir and over-throttles the recovery.
describe('runWithBYOKLimiter — tpm reservoir credit-back on failure (P1)', () => {
    beforeEach(() => {
        jest.useFakeTimers({ now: 0 });
        __limiterCacheInternals.cache.clear();
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('failed calls credit their estimate back — an outage does not drain the reservoir', async () => {
        // capacity 1000, seeded FULL; each call estimated at 400 tokens.
        const slot = tpmSlot('cipher-tpm-fail', { tpm: 1000 });
        const started: number[] = [];
        const failing = () => {
            started.push(Date.now());
            return Promise.reject(new Error('429 upstream outage'));
        };

        for (let i = 0; i < 3; i++) {
            runWithBYOKLimiter(
                { slot, estimatedTokens: 400 },
                failing,
            ).catch(() => undefined);
        }
        await flushMicrotasks();

        // With credit-back, each failure returns 400 to the reservoir, so all
        // three admit (the 3rd only after the first failure credits back). WITHOUT
        // the fix the reservoir sticks at 200 after two debits and the 3rd stalls.
        expect(started.length).toBe(3);

        // A 4th call must NOT be throttled — the reservoir was restored.
        let fourthStarted = false;
        runWithBYOKLimiter({ slot, estimatedTokens: 400 }, () => {
            fourthStarted = true;
            return Promise.resolve('ok');
        }).catch(() => undefined);
        await flushMicrotasks();
        expect(fourthStarted).toBe(true);
    });

    it('a SUCCESSFUL call still reconciles estimate→actual (credit-back does not double count)', async () => {
        // Regression guard: the reject-path credit must not also run on success.
        const slot = tpmSlot('cipher-tpm-ok', { tpm: 1000 });
        const started: number[] = [];
        // estimate 400, actual 400 → net debit 400 each; two calls leave 200,
        // so a third (est 400) is throttled until refill (reservoir gates it).
        const ok = () => {
            started.push(Date.now());
            return Promise.resolve({ tokens: 400 });
        };
        const getUsageTokens = (r: { tokens: number }) => r.tokens;

        for (let i = 0; i < 2; i++) {
            void runWithBYOKLimiter(
                { slot, estimatedTokens: 400, getUsageTokens },
                ok,
            );
        }
        await flushMicrotasks();
        expect(started.length).toBe(2); // 1000 → 600 → 200

        void runWithBYOKLimiter(
            { slot, estimatedTokens: 400, getUsageTokens },
            ok,
        );
        await flushMicrotasks();
        // reservoir at 200 < 400 → the 3rd is throttled (NOT credited back like a
        // failure would be); it only starts after enough refill time.
        expect(started.length).toBe(2);
    });
});

// ─── P2: bounded limiter cache (real timers) ─────────────────────────────────
describe('runWithBYOKLimiter — bounded limiter cache (P2)', () => {
    const { cache, max } = __limiterCacheInternals;

    afterEach(() => {
        cache.clear();
    });

    it('rotating the apiKey past the cap does not grow the cache unbounded', async () => {
        cache.clear();
        for (let i = 0; i < max + 50; i++) {
            const slot = tpmSlot(`rot-key-${i}`, { maxConcurrentRequests: 1 });
            // each call completes → limiter becomes idle → evictable.
            await runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        }
        expect(cache.size).toBeLessThanOrEqual(max);
    });

    it('never evicts an active (in-flight) limiter', async () => {
        cache.clear();
        const blocked = deferred<string>();
        const activeSlot = tpmSlot('active-key', { maxConcurrentRequests: 1 });

        // Start a task that never resolves → activeCount stays 1 (not idle).
        runWithBYOKLimiter({ slot: activeSlot }, () => blocked.promise).catch(
            () => undefined,
        );

        // Rotate many idle keys past the cap.
        for (let i = 0; i < max + 50; i++) {
            const slot = tpmSlot(`idle-${i}`, { maxConcurrentRequests: 1 });
            await runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        }

        // The active limiter must survive eviction.
        expect(getLimiterForSlot({ slot: activeSlot })).not.toBeNull();
        expect(cache.size).toBeLessThanOrEqual(max);

        blocked.resolve('done');
    });
});

// ─── O3: observability signals (fake timers, logger spy) ─────────────────────
describe('runWithBYOKLimiter — observability signals (O3)', () => {
    beforeEach(() => {
        jest.useFakeTimers({ now: 0 });
        __limiterCacheInternals.cache.clear();
        mockLoggerRecord.mockClear();
    });
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    const signals = () =>
        mockLoggerRecord.mock.calls.map((c) => c[0]?.metadata?.reason);

    it('emits an rpm-throttle signal with {provider, model, reason, waitMs}', async () => {
        const slot = rateSlot('cipher-o3-rpm', { rpm: 60 });
        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        await flushMicrotasks();

        expect(signals()).toContain('rpm-throttle');
        const call = mockLoggerRecord.mock.calls.find(
            (c) => c[0]?.metadata?.reason === 'rpm-throttle',
        );
        expect(call![0].metadata).toEqual(
            expect.objectContaining({
                provider: BYOKProvider.OPENAI,
                model: 'gpt-4o',
                reason: 'rpm-throttle',
                waitMs: expect.any(Number),
            }),
        );
    });

    it('emits a tpm-throttle signal when the reservoir cannot admit the head', async () => {
        const slot = tpmSlot('cipher-o3-tpm', { tpm: 1000 });
        // Two 600-token calls: first admits (1000→400), second needs 600 > 400.
        void runWithBYOKLimiter({ slot, estimatedTokens: 600 }, () =>
            Promise.resolve('ok'),
        );
        void runWithBYOKLimiter({ slot, estimatedTokens: 600 }, () =>
            Promise.resolve('ok'),
        );
        await flushMicrotasks();
        expect(signals()).toContain('tpm-throttle');
    });

    it('emits a cooldown-arm signal when armCooldown fires', async () => {
        const slot = cooldownSlot('cipher-o3-cd', { cooldownMs: 1000 });
        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        await flushMicrotasks();
        mockLoggerRecord.mockClear();

        getLimiterForSlot({ slot })!.armCooldown(1000);
        expect(signals()).toContain('cooldown-arm');
        const call = mockLoggerRecord.mock.calls.find(
            (c) => c[0]?.metadata?.reason === 'cooldown-arm',
        );
        expect(call![0].metadata.waitMs).toBe(1000);
    });

    it('emits a queue-timeout signal when a task times out waiting for a slot', async () => {
        const slot = tpmSlot('cipher-o3-qt', { maxConcurrentRequests: 1 });
        const blocked = deferred<string>();
        // First call holds the single slot.
        void runWithBYOKLimiter({ slot }, () => blocked.promise);
        await flushMicrotasks();
        // Second call waits with a 1000ms queue timeout.
        runWithBYOKLimiter(
            { slot, queueTimeoutMs: 1000 },
            () => Promise.resolve('never'),
        ).catch(() => undefined);
        await flushMicrotasks();

        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(signals()).toContain('queue-timeout');
        blocked.resolve('done');
    });

    it('never emits key material in any observability signal', async () => {
        const secret = 'cipher-o3-secret-must-not-log';
        const slot = tpmSlot(secret, { rpm: 60, cooldownMs: 1000 });
        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        void runWithBYOKLimiter({ slot }, () => Promise.resolve('ok'));
        await flushMicrotasks();
        getLimiterForSlot({ slot })!.armCooldown(1000);
        await flushMicrotasks();

        for (const call of mockLoggerRecord.mock.calls) {
            expect(JSON.stringify(call)).not.toContain(secret);
        }
    });
});

describe('buildModelFromSlot — secret hygiene (no plaintext key logged)', () => {
    it('never writes the decrypted key to any console sink', () => {
        const sinks = ['log', 'warn', 'error', 'info', 'debug'] as const;
        const spies = sinks.map((s) =>
            jest.spyOn(console, s).mockImplementation(() => undefined),
        );
        try {
            buildModelFromSlot({
                provider: BYOKProvider.OPENAI,
                apiKey: 'sk-super-secret',
                model: 'gpt-4o',
            } as NormalizedModel);

            for (const spy of spies) {
                for (const call of spy.mock.calls) {
                    expect(JSON.stringify(call)).not.toContain('sk-super-secret');
                }
            }
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
    });
});
