import { z } from 'zod';

// Mock the model builders so no real model/network is touched. v2-only:
// `buildModelFromSlot` takes ONE resolved slot. The production call reads the
// carrier's `.main` slot at its boundary, so the fallback slot is never handed
// to the builder — tests assert the single `main` model is used everywhere and
// that a 2nd (fallback) slot is NEVER built.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(() => ({ __model: 'main' })),
    getModelName: jest.fn(() => 'test-model'),
    // Default: no limiter cached (slot not in cooldown). Cooldown tests override
    // this to return a stub limiter reporting isInCooldown()=true.
    getLimiterForSlot: jest.fn(() => null),
    // json_schema fallback helpers (default: json_schema allowed, no error match).
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
}));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model: any) => model),
}));
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn(),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600000,
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({
        telemetry: { isEnabled: false },
    })),
}));
jest.mock('@libs/llm/reasoning-options', () => ({
    buildProviderOptions: jest.fn(() => ({ __providerOptions: 'reasoning' })),
    // resolveModelConfig consults this to suppress thinking on anthropic-protocol
    // structured calls; default false keeps these tests' behavior unchanged.
    structuredOutputForcesToolChoice: jest.fn(() => false),
}));

import {
    runStructuredReviewCall,
    runTextReviewCall,
} from '@libs/llm/structured-review-call';
import {
    NoObjectGeneratedError,
    JSONParseError,
    TypeValidationError,
    jsonSchema,
} from 'ai';
import { tracedGenerateText, timeoutSignal } from '@libs/llm/llm-call';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
import { setLlmObservability } from '@libs/llm/llm-observability';
import {
    buildModelFromSlot,
    getLimiterForSlot,
    isJsonSchemaUnsupportedError,
    markJsonSchemaUnsupported,
} from '@libs/llm/byok-to-vercel';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;
const mockBuild = buildModelFromSlot as unknown as jest.Mock;
const mockGetLimiter = getLimiterForSlot as unknown as jest.Mock;
const mockTimeoutSignal = timeoutSignal as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

const base = {
    schema: z.any(),
    system: 'sys',
    user: 'usr',
    runName: 'test.run',
    observabilityService,
};

const modelsUsed = () => mockGenerate.mock.calls.map((c) => c[0].model);

/** No 2nd (fallback) model is ever built — the run resolves ONE model. The
 *  builder is only ever handed the resolved `main` slot, never a fallback slot. */
const assertNoSecondModelBuilt = () => {
    expect(mockBuild).not.toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic' }),
        expect.anything(),
    );
    // Every generateText attempt ran the SAME (main) model — never a 2nd model.
    for (const model of modelsUsed()) {
        expect(model).toEqual({ __model: 'main' });
    }
};

beforeEach(() => {
    mockGenerate.mockReset();
    mockBuild.mockClear();
    mockGetLimiter.mockReset();
    mockGetLimiter.mockReturnValue(null); // default: slot not in cooldown
    (markJsonSchemaUnsupported as jest.Mock).mockClear();
    (isJsonSchemaUnsupportedError as jest.Mock).mockReturnValue(false);
    observabilityService.runAiSdkLLMInSpan.mockClear();
    (buildProviderOptions as jest.Mock).mockClear();
    // The executor records its span through the observability PORT — register
    // the mock so span assertions hit it (a specific test opts out below).
    setLlmObservability(observabilityService);
});

describe('runTextReviewCall — plain-text half of the shared executor', () => {
    const textBase = {
        system: 'sys',
        user: 'usr',
        runName: 'summary.run',
        observabilityService,
    };

    it('returns the raw generated string and sends NO structured-output arg', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'a prose summary', usage: {} });

        const out = await runTextReviewCall({ ...textBase });

        expect(out).toBe('a prose summary');
        // Plain generateText: no `output` (Output.object) on the call.
        expect(mockGenerate.mock.calls[0][0]).not.toHaveProperty('output');
        // And the model is NOT built in structured-output mode.
        expect(mockBuild).toHaveBeenCalledWith(undefined, {}, undefined);
    });

    it('shares the reasoning path — honors the slot the same way', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x', usage: {} });

        await runTextReviewCall({
            ...textBase,
            byokConfig: {
                provider: 'anthropic',
                apiKey: 'enc',
                model: 'claude-sonnet-4-5',
                reasoningEffort: 'medium',
            } as any,
        });

        expect(buildProviderOptions).toHaveBeenCalledWith(
            'summary.run',
            undefined,
            expect.objectContaining({ reasoningEffort: 'medium' }),
        );
        expect(mockGenerate.mock.calls[0][0].providerOptions).toEqual({
            __providerOptions: 'reasoning',
        });
    });

    it('an empty response degrades to an empty string (never throws)', async () => {
        mockGenerate.mockResolvedValueOnce({ usage: {} }); // no .text
        await expect(runTextReviewCall({ ...textBase })).resolves.toBe('');
    });

    it('threads defaultModelOverride to the build (trial default, e.g. the PR summary)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x', usage: {} });
        await runTextReviewCall({
            ...textBase,
            defaultModelOverride: 'accounts/fireworks/models/deepseek-v4-flash',
        });
        expect(mockBuild).toHaveBeenCalledWith(
            undefined,
            {},
            'accounts/fireworks/models/deepseek-v4-flash',
        );
    });

    it('forwards the slot\'s fallback provenance (route + usedFallback) to the span', async () => {
        // The failover cascade re-runs on a slot stamped usedFallback=true; the
        // executor must surface that on the span so a primary→fallback swap is
        // visible in observability (not a silent model change).
        mockGenerate.mockResolvedValueOnce({ text: 'x', usage: {} });
        await runTextReviewCall({
            ...textBase,
            byokConfig: {
                provider: 'openai',
                apiKey: 'enc',
                model: 'gpt-4o',
                route: 'codeReview',
                usedFallback: true,
            } as any,
        });
        const spanArgs =
            observabilityService.runAiSdkLLMInSpan.mock.calls[0][0];
        expect(spanArgs.usedFallback).toBe(true);
        expect(spanArgs.route).toBe('codeReview');
    });

    it('runs WITHOUT an observability service (bare caller) — no span, still returns text', async () => {
        setLlmObservability(undefined); // no port registered → no span
        mockGenerate.mockResolvedValueOnce({ text: 'no-span', usage: {} });
        const out = await runTextReviewCall({
            system: 'sys',
            user: 'usr',
            runName: 'bare.run',
        });
        expect(out).toBe('no-span');
        expect(observabilityService.runAiSdkLLMInSpan).not.toHaveBeenCalled();
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('honors a custom timeoutMs (secondary passes cap shorter than 10min)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x', usage: {} });
        await runTextReviewCall({ ...textBase, timeoutMs: 90_000 });
        expect(mockTimeoutSignal).toHaveBeenCalledWith(90_000);
    });
});

describe('runStructuredReviewCall — reasoning (honors the slot, no added default)', () => {
    it("passes the slot's reasoning through the SHARED mapping into the call", async () => {
        mockGenerate.mockResolvedValueOnce(ok({ ok: true }));

        await runStructuredReviewCall({
            ...base,
            byokConfig: {
                provider: 'openai',
                apiKey: 'enc',
                model: 'gpt-5',
                reasoningEffort: 'high',
            } as any,
        });

        // The slot's effort reaches the provider mapping (the drop this fixes)...
        expect(buildProviderOptions).toHaveBeenCalledWith(
            'test.run',
            undefined,
            expect.objectContaining({
                reasoningEffort: 'high',
                byokProvider: 'openai',
                modelName: 'gpt-5',
            }),
        );
        // ...and its result is spread as providerOptions on the SDK call.
        expect(mockGenerate.mock.calls[0][0].providerOptions).toEqual({
            __providerOptions: 'reasoning',
        });
    });

    it("an unset slot reasoning maps to 'none' (no added reasoning)", async () => {
        mockGenerate.mockResolvedValueOnce(ok({ ok: true }));
        await runStructuredReviewCall({ ...base }); // no byokConfig
        // The executor now assembles through resolveModelConfig with
        // reasoningEffortDefault:'none'. An unset slot therefore reaches the
        // mapping as the explicit 'none' rather than undefined — behaviorally
        // identical (buildReasoningProviderOptions folds `undefined ?? 'none'`
        // to the same {}), just no longer relying on the coalesce.
        expect(buildProviderOptions).toHaveBeenCalledWith(
            'test.run',
            undefined,
            expect.objectContaining({ reasoningEffort: 'none' }),
        );
    });
});

describe('span attrs.fallback — caller override vs default', () => {
    const spanAttrs = () =>
        observabilityService.runAiSdkLLMInSpan.mock.calls[0][0].attrs;

    it("defaults to false (there's no 2nd-model cascade) when the caller sets none", async () => {
        mockGenerate.mockResolvedValueOnce(ok({ ok: true }));
        await runStructuredReviewCall({ ...base });
        expect(spanAttrs().fallback).toBe(false);
    });

    it('respects attrs.fallback:true (a caller marking its OWN retry, e.g. kody-rules raw-JSON)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ ok: true }));
        await runStructuredReviewCall({ ...base, attrs: { fallback: true } });
        expect(spanAttrs().fallback).toBe(true);
    });
});

describe('runStructuredReviewCall — single-model policy (no runtime fallback)', () => {
    it('trial (no BYOK): runs the ONE resolved model and returns its output', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(modelsUsed()).toEqual([{ __model: 'main' }]);
        assertNoSecondModelBuilt();
    });

    it('trial (no BYOK): a non-transient main failure THROWS — no 2nd model', async () => {
        const authErr: any = new Error('invalid api key');
        authErr.status = 401;
        mockGenerate.mockRejectedValueOnce(authErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'invalid api key',
        );

        // Exactly one attempt — no Groq, no byok-fallback, no re-issue.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('BYOK: a main failure THROWS and never cascades to a 2nd model', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('byok main down'));

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: {
                    main: { provider: 'openai' },
                    // Even with a legacy `fallback` blob present, v2-only means
                    // no runtime cascade — the 2nd model is never built or run.
                    fallback: { provider: 'anthropic' },
                } as any,
            }),
        ).rejects.toThrow('byok main down');

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });
});

describe('runStructuredReviewCall — json_schema → json_object fallback', () => {
    it('retries once with json_object when the provider rejects json_schema, and caches the slot', async () => {
        // First attempt (json_schema) rejects with the schema-unsupported error;
        // the executor caches the slot and re-issues once with json_object.
        (isJsonSchemaUnsupportedError as jest.Mock).mockReturnValueOnce(true);
        mockGenerate
            .mockRejectedValueOnce(
                new Error('response_format json_schema is not supported'),
            )
            .mockResolvedValueOnce(ok({ recovered: true }));

        const out = await runStructuredReviewCall({ ...base });

        expect(markJsonSchemaUnsupported).toHaveBeenCalledTimes(1);
        // exactly two attempts: the json_schema try + the one json_object retry.
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(out).toEqual({ recovered: true });
    });
});

describe('runStructuredReviewCall — structured parse/validation recovery (issue #1786)', () => {
    const spanCalls = () => observabilityService.runAiSdkLLMInSpan.mock.calls;

    // Faithful stand-in for the error `generateText` + Output.object throws on a
    // parse/validation failure (`.text` = raw output, `.cause` = the underlying
    // JSONParseError / TypeValidationError). response/usage/finishReason are
    // required by the type but unread by the recovery path.
    const noObjectError = (cause: Error, text: string) =>
        new NoObjectGeneratedError({
            message: 'No object generated (test)',
            cause,
            text,
            response: {} as any,
            usage: {} as any,
            finishReason: 'stop',
        });

    it('deterministically repairs a JSON PARSE error (fence) WITHOUT a model re-ask', async () => {
        // Output.object threw NoObjectGeneratedError because the model wrapped the
        // JSON in a ```json fence. Free string repair fixes it → no 2nd model call.
        const badText = '```json\n{"violations":[]}\n```';
        const parseErr = new JSONParseError({
            text: badText,
            cause: new Error('Unexpected token `'),
        });
        mockGenerate.mockRejectedValueOnce(noObjectError(parseErr, badText));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(1); // recovered locally, no re-ask
        assertNoSecondModelBuilt();
    });

    it('escalates to ONE model re-ask (json_object + schema in prompt) on a SHAPE mismatch', async () => {
        // Valid JSON, wrong shape → TypeValidationError. String repair can't fix a
        // shape, so the executor re-asks the model with the schema in the prompt.
        const typeErr = new TypeValidationError({
            value: { wrong: 1 },
            cause: new Error('did not match schema'),
        });
        mockGenerate
            .mockRejectedValueOnce(noObjectError(typeErr, '{"wrong":1}'))
            .mockResolvedValueOnce(ok({ recovered: true }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ recovered: true });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        // The re-ask carries the schema in the system prompt (json_object can't
        // send it to the provider) — the missing contract is the #1786 root cause.
        expect(mockGenerate.mock.calls[1][0].system).toContain(
            'Return ONLY a JSON object',
        );
        // ...and the recovery is stamped on the re-ask span (not silent).
        expect(spanCalls()[1][0].attrs.structuredRecovery).toBe('schema-mismatch');
        // NOT a slot-level fault: the provider supports json_schema, the model
        // flubbed — so the slot is never cached as unsupported.
        expect(markJsonSchemaUnsupported).not.toHaveBeenCalled();
        assertNoSecondModelBuilt();
    });

    it('falls back to the model re-ask when deterministic repair cannot recover', async () => {
        // Parse error whose text is unrepairable garbage → repair returns
        // undefined → escalate to the one model re-ask rather than throwing.
        const badText = 'not json at all';
        mockGenerate
            .mockRejectedValueOnce(
                noObjectError(
                    new JSONParseError({
                        text: badText,
                        cause: new Error('nope'),
                    }),
                    badText,
                ),
            )
            .mockResolvedValueOnce(ok({ recovered: true }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ recovered: true });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(spanCalls()[1][0].attrs.structuredRecovery).toBe('schema-mismatch');
    });
});

describe('runStructuredReviewCall — typed output contract (compile-time inference)', () => {
    // These assignments are the real test: they only compile if the primitive
    // infers the caller's output type from the schema. A regression that widens
    // the return to `any`/`unknown` would still run but stop type-checking here.
    const typedBase = {
        system: 'sys',
        user: 'usr',
        runName: 't',
        observabilityService,
    };

    it('infers z.infer<S> from a zod schema and returns it', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ count: 5, label: 'x' }));
        const schema = z.object({ count: z.number(), label: z.string() });

        const out = await runStructuredReviewCall({ ...typedBase, schema });

        const count: number = out.count; // ← out is { count: number; label: string }
        const label: string = out.label;
        expect({ count, label }).toEqual({ count: 5, label: 'x' });
    });

    it('infers T from a jsonSchema<T>() Schema and returns it', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ sameBug: true }));

        const out = await runStructuredReviewCall({
            ...typedBase,
            schema: jsonSchema<{ sameBug: boolean }>({
                type: 'object',
                properties: { sameBug: { type: 'boolean' } },
                required: ['sameBug'],
                additionalProperties: false,
            } as any),
        });

        const sameBug: boolean = out.sameBug; // ← out is { sameBug: boolean }
        expect(sameBug).toBe(true);
    });
});

describe('runStructuredReviewCall — retained latency guard (D-00c: one gated SAME-model re-issue)', () => {
    it('transient main failure → exactly ONE SAME-model re-issue, returns its output', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValueOnce(ok({ violations: ['reissued'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['reissued'] });
        // main fails → ONE same-model re-issue succeeds. Both attempts are `main`.
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()).toEqual([{ __model: 'main' }, { __model: 'main' }]);
        assertNoSecondModelBuilt();
    });

    it('transient failure twice → single re-issue then THROWS (re-issue capped at one, no 2nd model)', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockRejectedValueOnce(new Error('socket hang up again'));

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'socket hang up again',
        );

        // main + exactly one same-model re-issue = 2 attempts, then propagate.
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()).toEqual([{ __model: 'main' }, { __model: 'main' }]);
        assertNoSecondModelBuilt();
    });

    it('AbortError → NO re-issue, THROWS (re-issuing a slow call just times out again)', async () => {
        const abortErr: any = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        mockGenerate.mockRejectedValueOnce(abortErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'The operation was aborted',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('[HARD-TIMEOUT] error → NO re-issue, THROWS', async () => {
        mockGenerate.mockRejectedValueOnce(
            new Error('[HARD-TIMEOUT] exceeded 600000ms'),
        );

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            '[HARD-TIMEOUT]',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('non-transient main failure (401 auth) → NO re-issue, THROWS', async () => {
        const authErr: any = new Error('invalid api key');
        authErr.status = 401;
        mockGenerate.mockRejectedValueOnce(authErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'invalid api key',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });
});

describe('runStructuredReviewCall — single retry owner (maxRetries:0 + cooldown-aware)', () => {
    it('pins maxRetries:0 on the SDK call so it is the ONLY retry layer', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({ ...base });

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ maxRetries: 0 }),
        );
    });

    it('maxRetries:0 is passed on BOTH the first attempt AND the D-00c re-issue', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValueOnce(ok({ violations: ['reissued'] }));

        await runStructuredReviewCall({ ...base });

        expect(mockGenerate).toHaveBeenCalledTimes(2);
        for (const call of mockGenerate.mock.calls) {
            expect(call[0]).toEqual(
                expect.objectContaining({ maxRetries: 0 }),
            );
        }
    });

    it('transient failure while the slot is IN COOLDOWN → NO re-issue, THROWS', async () => {
        // The wrapper armed the slot cooldown on the prior 429; the retry owner
        // must honor it — never re-fire into a cooling slot.
        mockGetLimiter.mockReturnValue({ isInCooldown: () => true });
        mockGenerate.mockRejectedValueOnce(new Error('fetch failed'));

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: { main: { provider: 'openai' } } as any,
            }),
        ).rejects.toThrow('fetch failed');

        // Exactly one attempt — the cooldown gate skipped the re-issue.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('RATE_LIMIT (429) failure → NO immediate re-fire, THROWS (backs off via cooldown)', async () => {
        // Slot in cooldown (arm-then-honor): a 429 never immediately re-issues.
        mockGetLimiter.mockReturnValue({ isInCooldown: () => true });
        const rateErr: any = new Error('rate limit exceeded');
        rateErr.status = 429;
        mockGenerate.mockRejectedValueOnce(rateErr);

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: { main: { provider: 'openai' } } as any,
            }),
        ).rejects.toThrow('rate limit');

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('RATE_LIMIT (429) with NO cooldown armed → still NO immediate re-fire, THROWS', async () => {
        // Even without a cooldown, a 429 is not hammered with an instant retry.
        mockGetLimiter.mockReturnValue(null);
        const rateErr: any = new Error('too many requests');
        rateErr.status = 429;
        mockGenerate.mockRejectedValueOnce(rateErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'too many requests',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('transient failure NOT in cooldown → still exactly ONE same-model re-issue', async () => {
        mockGetLimiter.mockReturnValue({ isInCooldown: () => false });
        mockGenerate
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockResolvedValueOnce(ok({ violations: ['reissued'] }));

        const out = await runStructuredReviewCall({
            ...base,
            byokConfig: { main: { provider: 'openai' } } as any,
        });

        expect(out).toEqual({ violations: ['reissued'] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        assertNoSecondModelBuilt();
    });
});

describe('runStructuredReviewCall — per-model tuning (RFC §4.1 model limits)', () => {
    it('passes the resolved slot temperature + maxOutputTokens to the model call', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({
            ...base,
            byokConfig: {
                provider: 'openai',
                temperature: 0.3,
                maxOutputTokens: 5000,
            } as any,
        });

        expect(mockGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ temperature: 0.3, maxOutputTokens: 5000 }),
        );
    });

    it('omits tuning when the slot does not set it (falls back to model defaults)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({ ...base }); // no slot at all

        const args = mockGenerate.mock.calls[0][0];
        expect(args).not.toHaveProperty('temperature');
        expect(args).not.toHaveProperty('maxOutputTokens');
    });

    it('treats a non-positive maxOutputTokens as "use the model default" (dropped)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({
            ...base,
            byokConfig: { provider: 'openai', maxOutputTokens: 0 } as any,
        });

        expect(mockGenerate.mock.calls[0][0]).not.toHaveProperty(
            'maxOutputTokens',
        );
    });
});
