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
    defaultReasoningEffortFor: () => undefined,
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
        mockGenerate.mockResolvedValueOnce({
            text: 'a prose summary',
            usage: {},
        });

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

    it("forwards the slot's fallback provenance (route + usedFallback) to the span", async () => {
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

describe('runStructuredReviewCall — reroute-json (always-thinking, e.g. Kimi k2.7-code)', () => {
    // A moonshot:kimi-k2.7-code slot is always-thinking (canDisableThinking=false)
    // over the Anthropic protocol (structuredOutput:'none'), so planStructuredCall
    // resolves to 'reroute-json': plain generateText + parse the text (no
    // Output.object / forced tool_choice). The REGISTRY is REAL here, so this
    // exercises the true plan, not a mock.
    const kimiSlot = {
        provider: 'moonshot',
        model: 'kimi-k2.7-code',
        apiKey: 'enc',
    } as any;

    it('parses PRISTINE JSON from r.text (no fence/whitespace) — regression for PR#152 Kimi kody-rules', async () => {
        // The model returned exactly `{"violations":[]}` — a valid empty result.
        // It used to throw "reroute-json produced no valid object" because
        // repairAndValidate rejected already-clean JSON, degrading the whole
        // Kody-Rules shard to zero findings ("all rule check(s) failed to run").
        mockGenerate.mockResolvedValueOnce({
            text: '{"violations":[]}',
            usage: {},
        });
        const out = await runStructuredReviewCall({
            ...base,
            schema: z.object({ violations: z.array(z.any()) }),
            byokConfig: kimiSlot,
        });
        expect(out).toEqual({ violations: [] });
        // Took the reroute path: plain generateText, NO Output.object channel.
        expect(mockGenerate.mock.calls[0][0]).not.toHaveProperty('output');
    });

    it('still parses fenced/prose-wrapped JSON on the same path', async () => {
        mockGenerate.mockResolvedValueOnce({
            text: 'Here you go:\n```json\n{"violations":[{"ruleId":1}]}\n```',
            usage: {},
        });
        const out = await runStructuredReviewCall({
            ...base,
            schema: z.object({
                violations: z.array(z.object({ ruleId: z.any() })),
            }),
            byokConfig: kimiSlot,
        });
        expect(out).toEqual({ violations: [{ ruleId: 1 }] });
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
        expect(spanCalls()[1][0].attrs.structuredRecovery).toBe(
            'schema-mismatch',
        );
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
        expect(spanCalls()[1][0].attrs.structuredRecovery).toBe(
            'schema-mismatch',
        );
    });
});

describe('runStructuredReviewCall — bare-array shape recovery (kody-rules shard #1786)', () => {
    // Evidence from prod (26/08–02/09): the KodyRulesShardedAgent's model
    // (kimi-k2.7 managed default) answers a BARE array — `[]` for "no
    // violations", `[{…}]` when it found some — instead of the wire envelope
    // `{violations:[…]}`. That is valid JSON of the wrong shape →
    // TypeValidationError. Today tier-(a) salvage bails (it only repairs PARSE
    // errors) and tier-(b) spends a full model re-ask that the same model flubs
    // the same way → the shard errors → shardsErrored++. When EVERY file is
    // clean the provider then throws "rules not applied" on a review that was
    // actually clean (Defeito A, 3961 events); a bare array that carried real
    // violations is dropped when a sibling shard posts (Defeito B'). The fix:
    // deterministically lift the bare array into the schema's envelope and
    // re-validate BEFORE the re-ask — free, and it stops the false failure.
    const noObjectError = (cause: Error, text: string) =>
        new NoObjectGeneratedError({
            message: 'No object generated (test)',
            cause,
            text,
            response: {} as any,
            usage: {} as any,
            finishReason: 'stop',
        });

    // A raw jsonSchema() envelope, exactly like shardViolationsWireSchema: a
    // bare `[]`/`[{…}]` fails it, `{violations:[…]}` passes.
    const envelopeSchema = jsonSchema({
        type: 'object',
        properties: { violations: { type: 'array', items: {} } },
        required: ['violations'],
        additionalProperties: false,
    } as any);

    it('recovers a bare EMPTY array [] into {violations:[]} WITHOUT a re-ask (a clean review is not a failure)', async () => {
        const typeErr = new TypeValidationError({
            value: [],
            cause: new Error('expected object, got array'),
        });
        mockGenerate.mockRejectedValueOnce(noObjectError(typeErr, '[]'));

        const out = await runStructuredReviewCall({
            ...base,
            schema: envelopeSchema,
            recoverEnvelopeShape: true,
        });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(1); // recovered locally, no re-ask
        assertNoSecondModelBuilt();
    });

    it('recovers a bare array WITH violations into {violations:[…]} WITHOUT a re-ask (no silent loss)', async () => {
        const vs = [{ ruleId: 1, violation: 'x' }];
        const typeErr = new TypeValidationError({
            value: vs,
            cause: new Error('expected object, got array'),
        });
        mockGenerate.mockRejectedValueOnce(
            noObjectError(typeErr, JSON.stringify(vs)),
        );

        const out = await runStructuredReviewCall({
            ...base,
            schema: envelopeSchema,
            recoverEnvelopeShape: true,
        });

        expect(out).toEqual({ violations: vs });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('still escalates to the model re-ask for a genuine shape mismatch (no over-recovery)', async () => {
        // A wrong-shape OBJECT with neither the envelope key nor a bare array is
        // not deterministically recoverable — it must still cost the one re-ask,
        // exactly as before. This guards against the fix over-reaching.
        const typeErr = new TypeValidationError({
            value: { wrong: 1 },
            cause: new Error('did not match schema'),
        });
        mockGenerate
            .mockRejectedValueOnce(noObjectError(typeErr, '{"wrong":1}'))
            .mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({
            ...base,
            schema: envelopeSchema,
            recoverEnvelopeShape: true,
        });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
    });

    it('recovers a bare array that arrived as PARSE-error text ([] + prose) WITHOUT a re-ask', async () => {
        // Prod group "array vazio como texto" (231): the model prints `[]` then
        // trailing prose, so the SDK raises a JSONParseError (not a
        // TypeValidationError). tier-(a) extracts `[]` but it fails the wire
        // schema; the shape recovery must still fire off the extracted value.
        const badText = '[]  No violations found in the provided diff.';
        const parseErr = new JSONParseError({
            text: badText,
            cause: new Error('Unexpected token'),
        });
        mockGenerate.mockRejectedValueOnce(noObjectError(parseErr, badText));

        const out = await runStructuredReviewCall({
            ...base,
            schema: envelopeSchema,
            recoverEnvelopeShape: true,
        });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('WITHOUT recoverEnvelopeShape, a bare array still re-asks (default contract preserved)', async () => {
        // Recovery is opt-in: a caller that did NOT opt in keeps the plain
        // "wrong shape → re-ask (signal, not silent)" behavior, so this generic
        // primitive never silently changes any other structured caller's contract.
        const typeErr = new TypeValidationError({
            value: [],
            cause: new Error('expected object, got array'),
        });
        mockGenerate
            .mockRejectedValueOnce(noObjectError(typeErr, '[]'))
            .mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({
            ...base,
            schema: envelopeSchema,
            // no recoverEnvelopeShape
        });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(2); // re-ask fired, not re-shaped
    });

    it('does NOT ship a re-shaped value that fails re-validation — falls to the re-ask', async () => {
        // Safety: the lift must be held to the EXACT contract. A bare array whose
        // items violate the schema (numbers where objects are required) re-shapes
        // to {violations:[1,2]} but that fails validation → we must NOT return it;
        // the re-ask still fires. Guards against recovering structurally-bad data.
        const strictSchema = jsonSchema({
            type: 'object',
            properties: {
                violations: { type: 'array', items: { type: 'object' } },
            },
            required: ['violations'],
            additionalProperties: false,
        } as any);
        const typeErr = new TypeValidationError({
            value: [1, 2],
            cause: new Error('expected object items'),
        });
        mockGenerate
            .mockRejectedValueOnce(noObjectError(typeErr, '[1,2]'))
            .mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({
            ...base,
            schema: strictSchema,
            recoverEnvelopeShape: true,
        });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(2); // re-shape rejected → re-ask
    });

    it('does NOT invent a recovery from an unparseable parse-error — falls to the re-ask', async () => {
        // recoverShape is on, but the JSONParseError text holds no extractable
        // JSON (genuine garbage / truncation) → no bad value to re-shape → the
        // re-ask runs, exactly as without recovery.
        const parseErr = new JSONParseError({
            text: 'not json at all',
            cause: new Error('nope'),
        });
        mockGenerate
            .mockRejectedValueOnce(noObjectError(parseErr, 'not json at all'))
            .mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({
            ...base,
            schema: envelopeSchema,
            recoverEnvelopeShape: true,
        });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
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
        expect(modelsUsed()).toEqual([
            { __model: 'main' },
            { __model: 'main' },
        ]);
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
        expect(modelsUsed()).toEqual([
            { __model: 'main' },
            { __model: 'main' },
        ]);
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
            expect(call[0]).toEqual(expect.objectContaining({ maxRetries: 0 }));
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
            expect.objectContaining({
                temperature: 0.3,
                maxOutputTokens: 5000,
            }),
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

// ---------------------------------------------------------------------------
// FULL I/O CONTRACT MATRIX (llm-io-contract-matrix.md).
//
// The DETERMINISTIC parse layers this boundary owns are (a) the reroute-json
// path — plain generateText + `repairAndValidate(validatingSchema, r.text)`, the
// json_object-equivalent branch where the FULL A/B/C output-shape zoo is in
// scope — and (b) the salvage/reissue path after Output.object throws
// NoObjectGeneratedError on the strict json_schema branch. Model decision
// QUALITY (whether a finding is correct) is the separate eval track and is NOT
// asserted here.
//
// The #1786 invariant: for every off-schema row the boundary must RECOVER the
// real payload OR SIGNAL explicitly (throw / re-ask) — NEVER silently keep-all /
// drop / default. This boundary honours it on every applicable row (reroute
// throws `produced no valid object` when repair returns undefined; the strict
// path re-asks the model in json_object mode with the schema in the prompt), so
// every row below is a normal `it` — there is NO silent-degradation `it.failing`
// for this boundary (knownDegradations is empty).
// ---------------------------------------------------------------------------

// A moonshot:kimi-k2.7-code slot is always-thinking → planStructuredCall resolves
// to 'reroute-json' (REGISTRY is REAL here): plain generateText, then the boundary
// PARSES + VALIDATES r.text against the caller's schema. This IS the json_object
// fallback branch of the E-matrix (kimi/glm/deepseek/z-ai) where the whole zoo is
// in scope.
const zooKimiSlot = {
    provider: 'moonshot',
    model: 'kimi-k2.7-code',
    apiKey: 'enc',
} as any;
const keepSchema = z.object({ keep: z.boolean() });
/** Feed one raw text back on the reroute path and run the parse layer. */
const parseReroute = <S extends z.ZodType>(schema: S, text: string) => {
    mockGenerate.mockResolvedValueOnce({ text, usage: {} });
    return runStructuredReviewCall({ ...base, schema, byokConfig: zooKimiSlot });
};

describe('MATRIX A — output-shape zoo (E: json_object/reroute branch, full zoo in scope)', () => {
    it('row 1 — exact D parses and returns verbatim (happy path)', async () => {
        await expect(parseReroute(keepSchema, '{"keep":true}')).resolves.toEqual(
            { keep: true },
        );
        // Reroute took the plain-generateText channel (NO Output.object).
        expect(mockGenerate.mock.calls[0][0]).not.toHaveProperty('output');
    });

    it('row 2 — bare array when D is an object → SIGNALS (throws, never keep-all)', async () => {
        await expect(
            parseReroute(keepSchema, '[{"keep":true}]'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 3 — single value where D expects an array → SIGNALS', async () => {
        const arrSchema = z.object({ items: z.array(z.number()) });
        await expect(
            parseReroute(arrSchema, '{"items":5}'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 4 — wrapper key {result:D} is NOT silently unwrapped → SIGNALS', async () => {
        await expect(
            parseReroute(keepSchema, '{"result":{"keep":true}}'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 5 — double wrapper {result:{result:D}} → SIGNALS', async () => {
        await expect(
            parseReroute(keepSchema, '{"result":{"result":{"keep":true}}}'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 6 — numeric/opaque single-key wrap {"0":D} / {content:D} → SIGNALS', async () => {
        await expect(
            parseReroute(keepSchema, '{"0":{"keep":true}}'),
        ).rejects.toThrow('produced no valid object');
        await expect(
            parseReroute(keepSchema, '{"content":{"keep":true}}'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 7 — whole D as a stringified JSON string is NOT double-parsed → SIGNALS', async () => {
        await expect(
            parseReroute(keepSchema, '"{\\"keep\\":true}"'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 8 — markdown-fenced JSON is RECOVERED', async () => {
        await expect(
            parseReroute(keepSchema, '```json\n{"keep":true}\n```'),
        ).resolves.toEqual({ keep: true });
    });

    it('row 9 — prose-wrapped JSON (no fence) is RECOVERED', async () => {
        await expect(
            parseReroute(
                keepSchema,
                'Sure — here is the result: {"keep":true}\n\nLet me know if…',
            ),
        ).resolves.toEqual({ keep: true });
    });

    it('row 10 — right data / WRONG (renamed) keys → SIGNALS (the #1786 class, no keep-all)', async () => {
        await expect(parseReroute(keepSchema, '{"kept":true}')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 11 — case/convention mismatch ({"Keep":true}) → SIGNALS', async () => {
        await expect(parseReroute(keepSchema, '{"Keep":true}')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 12 — partial object (a required key missing) → SIGNALS', async () => {
        const twoKey = z.object({ keep: z.boolean(), reason: z.string() });
        await expect(parseReroute(twoKey, '{"keep":true}')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 13 — extra unknown keys alongside the right ones are TOLERATED (stripped, not crash)', async () => {
        await expect(
            parseReroute(keepSchema, '{"keep":true,"debug":"x","extra":99}'),
        ).resolves.toEqual({ keep: true });
    });

    it('row 14 — empty object {} against a required schema → SIGNALS', async () => {
        await expect(parseReroute(keepSchema, '{}')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 15 — empty array [] against an object schema → SIGNALS', async () => {
        await expect(parseReroute(keepSchema, '[]')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 16 — empty / whitespace-only text → SIGNALS (no JSON to parse)', async () => {
        await expect(parseReroute(keepSchema, '   \n\t ')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 17 — null/undefined text (no r.text) → SIGNALS', async () => {
        mockGenerate.mockResolvedValueOnce({ usage: {} }); // no .text field at all
        await expect(
            runStructuredReviewCall({
                ...base,
                schema: keepSchema,
                byokConfig: zooKimiSlot,
            }),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 18 — primitive where an object is expected (true / "ok") → SIGNALS', async () => {
        await expect(parseReroute(keepSchema, 'true')).rejects.toThrow(
            'produced no valid object',
        );
        await expect(parseReroute(keepSchema, '"ok"')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 19 — provider envelope leak {choices:[{message:{content}}]} → SIGNALS', async () => {
        await expect(
            parseReroute(
                keepSchema,
                '{"choices":[{"message":{"content":"{\\"keep\\":true}"}}]}',
            ),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 20 — reasoning/thinking prefix before the JSON is stripped and the payload RECOVERED', async () => {
        await expect(
            parseReroute(
                keepSchema,
                '<thinking>let me decide…</thinking>\n{"keep":true}',
            ),
        ).resolves.toEqual({ keep: true });
    });
});

describe('MATRIX B — semantic-but-wrong value encodings (reroute parse layer)', () => {
    it('row 21 — boolean as string ("true") is NOT coerced → SIGNALS', async () => {
        await expect(
            parseReroute(keepSchema, '{"keep":"true"}'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 22 — boolean as yes/no ("yes") → SIGNALS', async () => {
        await expect(parseReroute(keepSchema, '{"keep":"yes"}')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 23 — boolean as number (1) → SIGNALS', async () => {
        await expect(parseReroute(keepSchema, '{"keep":1}')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 24 — enum value outside the allowed set → SIGNALS', async () => {
        const sevSchema = z.object({
            severity: z.enum(['low', 'medium', 'high']),
        });
        await expect(
            parseReroute(sevSchema, '{"severity":"URGENT"}'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 26 — duplicate keys in the JSON object resolve LAST-WINS', async () => {
        await expect(
            parseReroute(keepSchema, '{"keep":false,"keep":true}'),
        ).resolves.toEqual({ keep: true });
    });

    it('row 27 — unicode / escaped-newline / emoji inside string fields survive (string-aware slice)', async () => {
        const noteSchema = z.object({ keep: z.boolean(), note: z.string() });
        await expect(
            parseReroute(
                noteSchema,
                '{"keep":true,"note":"h\\u00e9llo \\n 🎉 {not:a:real:brace}"}',
            ),
        ).resolves.toEqual({ keep: true, note: 'héllo \n 🎉 {not:a:real:brace}' });
    });
});

describe('MATRIX C — unparseable / transport (the fail-safe layer)', () => {
    it('row 28 — truncated JSON (max_tokens mid-object) → SIGNALS, never partial keep', async () => {
        await expect(parseReroute(keepSchema, '{"keep":tr')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 29 — malformed JSON: trailing comma is REPAIRED; single-quote / unquoted-key SIGNAL', async () => {
        await expect(
            parseReroute(keepSchema, '{"keep":true,}'),
        ).resolves.toEqual({ keep: true });
        await expect(parseReroute(keepSchema, "{'keep':true}")).rejects.toThrow(
            'produced no valid object',
        );
        await expect(parseReroute(keepSchema, '{keep:true}')).rejects.toThrow(
            'produced no valid object',
        );
    });

    it('row 30 — LLM.run throws on the reroute path → propagates (no silent swallow, no 2nd model)', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('network reset'));
        await expect(
            runStructuredReviewCall({
                ...base,
                schema: keepSchema,
                byokConfig: zooKimiSlot,
            }),
        ).rejects.toThrow('network reset');
        // Reroute is single-shot: exactly one attempt, no 2nd-model cascade.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('row 31 — model returned an {error:…} object instead of D → SIGNALS', async () => {
        await expect(
            parseReroute(keepSchema, '{"error":"rate limited, try later"}'),
        ).rejects.toThrow('produced no valid object');
    });

    it('row 32 — empty success (content:"") on the structured path → SIGNALS; the TEXT path degrades to ""', async () => {
        await expect(parseReroute(keepSchema, '')).rejects.toThrow(
            'produced no valid object',
        );
        // The text half of the same executor never throws on empty content.
        mockGenerate.mockResolvedValueOnce({ text: '', usage: {} });
        await expect(
            runTextReviewCall({ system: 's', user: 'u', runName: 'r' }),
        ).resolves.toBe('');
    });

    it('row 33 — refusal prose ("I cannot help…") → structured SIGNALS; text returns it verbatim', async () => {
        await expect(
            parseReroute(keepSchema, 'I cannot help with that request.'),
        ).rejects.toThrow('produced no valid object');
        mockGenerate.mockResolvedValueOnce({
            text: 'I cannot help with that request.',
            usage: {},
        });
        await expect(
            runTextReviewCall({ system: 's', user: 'u', runName: 'r' }),
        ).resolves.toBe('I cannot help with that request.');
    });

    it('row 34 — abort/hard-timeout is NEVER re-issued (covered on the as-is path too)', async () => {
        const abortErr: any = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        mockGenerate.mockRejectedValueOnce(abortErr);
        await expect(
            runStructuredReviewCall({
                ...base,
                schema: keepSchema,
                byokConfig: zooKimiSlot,
            }),
        ).rejects.toThrow('The operation was aborted');
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });
});

describe('MATRIX E — strict json_schema branch (openai/anthropic/google/moonshotai) trusts clean D', () => {
    const openaiSlot = {
        provider: 'openai',
        apiKey: 'enc',
        model: 'gpt-4o',
    } as any;

    it('strict branch: a clean D from Output.object is returned verbatim (SDK owns validation)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        const out = await runStructuredReviewCall({
            ...base,
            schema: keepSchema,
            byokConfig: openaiSlot,
        });
        expect(out).toEqual({ keep: true });
        // Strict branch uses the Output.object channel (NOT reroute plain text).
        expect(mockGenerate.mock.calls[0][0]).toHaveProperty('output');
        // …and the system prompt is NOT augmented with a schema (that is the
        // json_object recovery only).
        expect(mockGenerate.mock.calls[0][0].system).toBe('sys');
    });

    it('strict branch off-schema: Output.object throws → ONE json_object re-ask with schema in prompt', async () => {
        const typeErr = new TypeValidationError({
            value: { kept: true },
            cause: new Error('renamed key'),
        });
        mockGenerate
            .mockRejectedValueOnce(
                new NoObjectGeneratedError({
                    message: 'No object generated (test)',
                    cause: typeErr,
                    text: '{"kept":true}',
                    response: {} as any,
                    usage: {} as any,
                    finishReason: 'stop',
                }),
            )
            .mockResolvedValueOnce(ok({ keep: true }));

        const out = await runStructuredReviewCall({
            ...base,
            schema: keepSchema,
            byokConfig: openaiSlot,
        });

        expect(out).toEqual({ keep: true });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        // The recovery is OBSERVABLE (schema written into the re-ask prompt) —
        // the #1786 root cause was the missing prompt contract in json_object mode.
        expect(mockGenerate.mock.calls[1][0].system).toContain(
            'Return ONLY a JSON object',
        );
        // NOT a slot-level fault: the provider honoured json_schema, the model
        // flubbed the shape → the slot is never cached unsupported.
        expect(markJsonSchemaUnsupported).not.toHaveBeenCalled();
    });
});

describe('MATRIX E/#1786 — a raw jsonSchema() caller (no validate fn) is STILL protected', () => {
    // The dedup pass hands a raw `jsonSchema()` with NO validate function. Without
    // `ensureValidatingSchema` (added centrally), Output.object would parse-but-
    // not-check and a renamed-key object would ship silently (the keep-all class).
    // On the reroute branch the boundary validates r.text against the SAME
    // ensured schema, so a renamed payload must be REJECTED, not returned.
    const rawSchema = jsonSchema<{ keep: boolean }>({
        type: 'object',
        properties: { keep: { type: 'boolean' } },
        required: ['keep'],
        additionalProperties: false,
    } as any);

    it('clean D validates and returns', async () => {
        mockGenerate.mockResolvedValueOnce({ text: '{"keep":true}', usage: {} });
        await expect(
            runStructuredReviewCall({
                ...base,
                schema: rawSchema,
                byokConfig: zooKimiSlot,
            }),
        ).resolves.toEqual({ keep: true });
    });

    it('renamed keys are REJECTED (ensureValidatingSchema compiled an ajv validator) → SIGNALS', async () => {
        mockGenerate.mockResolvedValueOnce({ text: '{"kept":true}', usage: {} });
        await expect(
            runStructuredReviewCall({
                ...base,
                schema: rawSchema,
                byokConfig: zooKimiSlot,
            }),
        ).rejects.toThrow('produced no valid object');
    });
});

describe('MATRIX D — input variants (request assembly threading, happy LLM.run)', () => {
    it('row 35 — empty user prompt threads through verbatim (no substitution)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        await runStructuredReviewCall({ ...base, schema: keepSchema, user: '' });
        expect(mockGenerate.mock.calls[0][0].prompt).toBe('');
    });

    it('row 36 — a single normal call assembles exactly one generateText with system+prompt', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        await runStructuredReviewCall({
            ...base,
            schema: keepSchema,
            system: 'the-system',
            user: 'the-user',
        });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(mockGenerate.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                system: 'the-system',
                prompt: 'the-user',
                maxRetries: 0,
            }),
        );
    });

    it('row 37 — a large user prompt crossing any chunk size threads through unchanged (no truncation)', async () => {
        const huge = 'diff-line\n'.repeat(50_000);
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        await runStructuredReviewCall({
            ...base,
            schema: keepSchema,
            user: huge,
        });
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(huge);
        expect(mockGenerate.mock.calls[0][0].prompt.length).toBe(huge.length);
    });

    it('row 39 — an omitted (null-ish) system field is passed as undefined, not fabricated', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        await runStructuredReviewCall({
            byokConfig: undefined,
            schema: keepSchema,
            user: 'only-user',
            runName: 'no.system',
        } as any);
        expect(mockGenerate.mock.calls[0][0].system).toBeUndefined();
    });

    it('row 40 — special chars / emoji / whitespace-only diff thread through verbatim', async () => {
        const weird = '\t\n  🚀 <script> [31m ```` "quotes" \\n  ';
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        await runStructuredReviewCall({
            ...base,
            schema: keepSchema,
            user: weird,
        });
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(weird);
    });

    it('threading — the resolved byokConfig slot is handed to the model builder (not a copy/2nd slot)', async () => {
        const slot = {
            provider: 'openai',
            apiKey: 'enc',
            model: 'gpt-4o',
        } as any;
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        await runStructuredReviewCall({
            ...base,
            schema: keepSchema,
            byokConfig: slot,
        });
        expect(mockBuild.mock.calls[0][0]).toEqual(slot);
    });
});

describe('MATRIX — guaranteed return shape across every layer', () => {
    it('structured happy / repair / reissue all return the DECLARED object shape', async () => {
        // happy
        mockGenerate.mockResolvedValueOnce(ok({ keep: true }));
        expect(
            await runStructuredReviewCall({ ...base, schema: keepSchema }),
        ).toEqual({ keep: true });

        // deterministic repair (fence) — still the declared shape, no re-ask
        mockGenerate.mockReset();
        mockGenerate.mockRejectedValueOnce(
            new NoObjectGeneratedError({
                message: 'x',
                cause: new JSONParseError({
                    text: '```json\n{"keep":true}\n```',
                    cause: new Error('fence'),
                }),
                text: '```json\n{"keep":true}\n```',
                response: {} as any,
                usage: {} as any,
                finishReason: 'stop',
            }),
        );
        expect(
            await runStructuredReviewCall({ ...base, schema: keepSchema }),
        ).toEqual({ keep: true });
    });

    it('the TEXT half always returns a string (never undefined), even on empty content', async () => {
        mockGenerate.mockResolvedValueOnce({ usage: {} }); // no .text
        const out = await runTextReviewCall({
            system: 's',
            user: 'u',
            runName: 'r',
        });
        expect(typeof out).toBe('string');
        expect(out).toBe('');
    });
});
