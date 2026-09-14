/**
 * LLMAnalysisService — migrated-consumer parity spec (Phase 3, plan 03-06).
 *
 * llmAnalysis sits on the customer review hot path for its surviving methods
 * (severityAnalysisAssignment, validateImplementedSuggestions,
 * filterSuggestionsSafeGuard), so this spec is mandatory for those (not a
 * grep-only gate). It proves the "no behavior change on the happy path"
 * contract after migrating the structured call-sites off the legacy
 * BYOKPromptRunner LangChain path onto the AI SDK path
 * (runStructuredReviewCall).
 *
 * `analyzeCodeWithAI` / `analyzeCodeWithAI_v2` / `generateCodeSuggestions` /
 * `selectReviewMode` were deleted as unreachable — see the note above
 * `LLMAnalysisService — secondary analysis methods` below.
 */

// Model builders return sentinels — no real model/network is touched.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    buildModelFromSlot: jest.fn(() => ({ __model: 'byok-main' })),
    getModelName: jest.fn(() => 'byok-main'),
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
    toAiSdkTelemetryArgs: jest.fn(() => ({ telemetry: { isEnabled: false } })),
}));

import {
    LLMAnalysisService,
    severityAnalysisSchema,
    validateImplementedSchema,
} from './llmAnalysis.service';
import { setLlmObservability } from '@libs/llm/llm-observability';
import { LLM } from '@libs/llm/llm';
import { ReviewModeResponse } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { prompt_severity_analysis_user } from '@libs/common/utils/prompts/severityAnalysis';
import { prompt_validateImplementedSuggestions } from '@libs/common/utils/prompts';

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
// runLLMInSpan is the OLD LangChain wrapper; it must never be touched (Q4).
const observability = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
    runLLMInSpan: jest.fn(),
} as any;

const safeguardPipeline = {} as any;

function buildService(): LLMAnalysisService {
    return new LLMAnalysisService(observability, safeguardPipeline);
}

const organizationAndTeamData = {
    organizationId: 'org-1',
    teamId: 'team-1',
} as any;

const fileContext = {
    file: {
        filename: 'src/payments/charge.ts',
        fileContent: 'export function charge() {}',
    },
    patchWithLinesStr: '42 + charge(customer.id)',
    relevantContent: 'export function charge() {}',
    hasRelevantContent: true,
} as any;

const context = {
    pullRequest: { number: 77, body: 'Add charge retries' },
    repository: { language: 'typescript' },
    codeReviewConfig: {
        suggestionControl: {},
        reviewOptions: {},
        languageResultPrompt: 'en-US',
    },
    organizationAndTeamData,
} as any;

// Flat NormalizedModel (the single stored format) — the `{ main, fallback }`
// carrier is retired, so `provider` sits on the slot directly.
const byokConfig = {
    provider: 'openai',
    model: 'gpt-4o',
} as any;

/**
 * The secondary analysis methods — severity, implemented-check and safeguard.
 * `analyzeCodeWithAI` / `analyzeCodeWithAI_v2` / `generateCodeSuggestions` /
 * `selectReviewMode` were deleted as unreachable: their only callers were
 * `CodeAnalysisOrchestrator` and the pre-agent-v4 `ProcessFilesReview` /
 * `ProcessFilesPrLevelReviewStage`, none of which appear in either active
 * pipeline strategy (`CodeReviewPipelineStrategy`, `CliReviewPipelineStrategy`).
 *
 * These three each own a fail-safe contract (a provider failure must degrade to
 * the INPUT suggestions, never drop them) and a distinct request shape (severity
 * carries the org's BYOK slot; the implemented-check runs on whatever slot the
 * caller resolves — `undefined` when the org has none configured for the task —
 * never a hardcoded provider). A regression that swallows the fallback or
 * crosses the wires is invisible elsewhere.
 *
 * We spy on LLM.run directly and, for the success paths, stub the internal
 * response processor.
 */
describe('LLMAnalysisService — secondary analysis methods', () => {
    const org = organizationAndTeamData;
    const suggestions = [
        { id: 's1', severity: 'low' },
        { id: 's2', severity: 'low' },
    ] as any[];

    let runSpy: jest.SpyInstance;
    beforeEach(() => {
        setLlmObservability(observability);
        runSpy = jest.spyOn(LLM, 'run');
    });
    afterEach(() => runSpy.mockRestore());

    describe('severityAnalysisAssignment', () => {
        it('assembles the severity request with the schema, prompt and BYOK slot', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockReturnValue({ codeSuggestions: [{ id: 's1' }] });

            await service.severityAnalysisAssignment(
                org,
                77,
                suggestions,
                byokConfig,
            );

            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(severityAnalysisSchema);
            expect(arg.user).toBe(prompt_severity_analysis_user(suggestions));
            expect(arg.runName).toBe('severityAnalysis');
            expect(arg.byokConfig).toBe(byokConfig); // the org's slot, not undefined
        });

        it('returns the parsed suggestions on success', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();
            const processed = [{ id: 's1', severity: 'high' }];
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockReturnValue({ codeSuggestions: processed });

            const out = await service.severityAnalysisAssignment(
                org,
                77,
                suggestions,
                byokConfig,
            );
            expect(out).toEqual(processed);
        });

        it('falls back to the ORIGINAL suggestions when the call throws', async () => {
            runSpy.mockRejectedValue(new Error('provider down'));
            const service = buildService();

            const out = await service.severityAnalysisAssignment(
                org,
                77,
                suggestions,
                byokConfig,
            );
            expect(out).toBe(suggestions);
        });

        it('falls back to the ORIGINAL suggestions when the model returns nothing', async () => {
            runSpy.mockResolvedValue(null as any);
            const service = buildService();

            const out = await service.severityAnalysisAssignment(
                org,
                77,
                suggestions,
                byokConfig,
            );
            expect(out).toBe(suggestions);
        });
    });

    describe('validateImplementedSuggestions', () => {
        it('runs on the managed default (byokConfig undefined) with the implemented schema', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockReturnValue({ codeSuggestions: [] });

            await service.validateImplementedSuggestions(
                org,
                77,
                undefined,
                'diff',
                suggestions,
            );

            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(validateImplementedSchema);
            expect(arg.user).toBe(
                prompt_validateImplementedSuggestions({
                    codePatch: 'diff',
                    codeSuggestions: suggestions,
                }),
            );
            expect(arg.runName).toBe('validateImplementedSuggestions');
            // Whatever byokConfig the caller resolved is forwarded verbatim —
            // undefined here means the org has no BYOK slot for this task, so
            // LLM.run falls back to the managed default.
            expect(arg.byokConfig).toBeUndefined();
        });

        it('returns the parsed implemented-status suggestions on success', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();
            const processed = [
                { id: 's1', implementationStatus: 'implemented' },
            ];
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockReturnValue({ codeSuggestions: processed });

            const out = await service.validateImplementedSuggestions(
                org,
                77,
                undefined,
                'diff',
                suggestions,
            );
            expect(out).toEqual(processed);
        });

        it('falls back to the ORIGINAL suggestions on failure', async () => {
            runSpy.mockRejectedValue(new Error('boom'));
            const service = buildService();

            const out = await service.validateImplementedSuggestions(
                org,
                77,
                undefined,
                'diff',
                suggestions,
            );
            expect(out).toBe(suggestions);
        });

        it('falls back to the ORIGINAL suggestions when the model returns nothing', async () => {
            runSpy.mockResolvedValue(null as any);
            const service = buildService();

            const out = await service.validateImplementedSuggestions(
                org,
                77,
                undefined,
                'diff',
                suggestions,
            );
            expect(out).toBe(suggestions);
        });
    });

    describe('filterSuggestionsSafeGuard', () => {
        const buildWithPipeline = (execute: jest.Mock) =>
            new LLMAnalysisService(observability, { execute } as any);

        it('strips suggestionEmbedded before delegating, leaving other suggestions intact', async () => {
            const execute = jest.fn().mockResolvedValue({ suggestions: 'ok' });
            const service = buildWithPipeline(execute);
            const input = [
                { id: 'a', suggestionEmbedded: { vec: [1] }, keep: 1 },
                { id: 'b' },
            ] as any[];

            await service.filterSuggestionsSafeGuard(
                org,
                77,
                { filename: 'f.ts' },
                'content',
                'diff',
                input,
                'en-US',
                ReviewModeResponse.HEAVY_MODE,
                byokConfig,
            );

            const payload = execute.mock.calls[0][0];
            expect(payload.suggestions[0]).not.toHaveProperty(
                'suggestionEmbedded',
            );
            expect(payload.suggestions[0].keep).toBe(1);
            expect(payload.suggestions[1]).toEqual({ id: 'b' });
        });

        it('does not throw on a null suggestion entry', async () => {
            const execute = jest.fn().mockResolvedValue({ suggestions: [] });
            const service = buildWithPipeline(execute);

            await expect(
                service.filterSuggestionsSafeGuard(
                    org,
                    77,
                    { filename: 'f.ts' },
                    'content',
                    'diff',
                    [null, { id: 'x', suggestionEmbedded: 1 }] as any[],
                    'en-US',
                    ReviewModeResponse.HEAVY_MODE,
                    byokConfig,
                ),
            ).resolves.toBeDefined();
        });

        it('is fail-safe: a pipeline failure returns the (stripped) suggestions instead of dropping them', async () => {
            const execute = jest.fn().mockRejectedValue(new Error('pipeline'));
            const service = buildWithPipeline(execute);
            const input = [{ id: 'a', suggestionEmbedded: 1 }] as any[];

            const out = await service.filterSuggestionsSafeGuard(
                org,
                77,
                { filename: 'f.ts' },
                'content',
                'diff',
                input,
                'en-US',
                ReviewModeResponse.HEAVY_MODE,
                byokConfig,
            );

            expect(out).toEqual({ suggestions: input });
            expect(input[0]).not.toHaveProperty('suggestionEmbedded');
        });
    });

});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LLM.run I/O CONTRACT MATRIX — full 42-row closure for the review-chain
 * boundaries this service owns.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SCOPE: the DETERMINISTIC layer only — request assembly (schema/system/user/
 * byokConfig/runName/attrs/organizationId threading), the envelope handling
 * (`if (!x) …` guard), the `JSON.stringify(result) → processResponse` re-parse,
 * and the guaranteed return shape. Model decision QUALITY is out of scope.
 *
 * The two surviving analyzer boundaries (severityAnalysisAssignment,
 * validateImplementedSuggestions — analyzeCodeWithAI/_v2/generateCodeSuggestions
 * were deleted as unreachable) share ONE parse shape:
 *   LLM.run(schema) → object → JSON.stringify(object) → processResponse()
 * where `processResponse` only recognises a payload whose top-level
 * `codeSuggestions` is an array (llmResponseProcessor.transform.ts:32,49,61).
 *
 * THE #1786 DEGRADATION (recorded as it.failing, green now / red on the fix):
 * a TRUTHY-BUT-OFF-SCHEMA envelope (bare array, wrapper key, stringified blob,
 * right-data-wrong-key, primitive, error object, refusal prose …) is NOT falsy,
 * so it skips the `if (!result)` fail-safe-to-INPUT guard, then fails the
 * `Array.isArray(codeSuggestions)` recognition inside processResponse, and the
 * `?.codeSuggestions || []` defaults SILENTLY DROP every input suggestion to
 * [] with no signal. The correct behavior is to RECOVER the payload OR fall
 * back to the INPUT suggestions (the documented safe default the throw path
 * already produces) — never a silent [].
 * The pin `expect(out).not.toEqual([])` turns red the moment either fix lands.
 *
 * A second structural degradation: because every path calls JSON.stringify()
 * BEFORE processResponse, a STRING result from LLM.run (json_object fallback
 * models can hand back a raw string) is double-encoded and the whole
 * markdown/prose/JSON5-repair machinery inside processResponse is defeated
 * (rows 7/8/9/28/29/33).
 *
 * We spy on the REAL LLM.run boundary and restore after each test.
 */
describe('LLMAnalysisService — LLM.run I/O contract matrix', () => {
    const org = organizationAndTeamData;
    const inputSuggestions = [
        { id: 's1', severity: 'low', relevantFile: 'a.ts' },
        { id: 's2', severity: 'low', relevantFile: 'b.ts' },
    ] as any[];

    let runSpy: jest.SpyInstance;
    beforeEach(() => {
        jest.clearAllMocks();
        setLlmObservability(observability);
        runSpy = jest.spyOn(LLM, 'run');
    });
    afterEach(() => runSpy.mockRestore());

    // The severity boundary is the primary vehicle: it goes through the shared
    // processResponse re-parse AND owns the fail-safe-to-INPUT contract, so both
    // the recover branch and the #1786 silent-drop are observable on it.
    const runSeverity = (service: LLMAnalysisService, input = inputSuggestions) =>
        service.severityAnalysisAssignment(org, 77, input, byokConfig);

    // ── A. Output-shape zoo ────────────────────────────────────────────────

    it('A1 — exact D {codeSuggestions:[...]} is returned as the parsed suggestions', async () => {
        const payload = [
            { id: 's1', severity: 'critical' },
            { id: 's2', severity: 'high' },
        ];
        runSpy.mockResolvedValue({ codeSuggestions: payload } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual(payload);
    });

    it.failing(
        'A2 — bare array of inner items must NOT silently drop to [] (#1786: recover or fall back to input)',
        async () => {
            runSpy.mockResolvedValue([
                { id: 's1', severity: 'high' },
            ] as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A3 — single object where an array is expected (codeSuggestions as object) must not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                codeSuggestions: { id: 's1', severity: 'high' },
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A4 — wrapper key {result:D} must be unwrapped or fall back, not silently dropped',
        async () => {
            runSpy.mockResolvedValue({
                result: { codeSuggestions: [{ id: 's1', severity: 'high' }] },
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A5 — double wrapper {result:{result:D}} must not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                result: {
                    result: {
                        codeSuggestions: [{ id: 's1', severity: 'high' }],
                    },
                },
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A6 — opaque single-key wrap {content:D} / {"0":D} must not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                content: { codeSuggestions: [{ id: 's1', severity: 'high' }] },
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A7 — stringified JSON payload (double-encoded by JSON.stringify) must not silently drop',
        async () => {
            runSpy.mockResolvedValue(
                JSON.stringify({
                    codeSuggestions: [{ id: 's1', severity: 'high' }],
                }) as any,
            );
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A8 — markdown-fenced JSON string must not silently drop (JSON.stringify defeats the fence-stripper)',
        async () => {
            runSpy.mockResolvedValue(
                '```json\n{"codeSuggestions":[{"id":"s1","severity":"high"}]}\n```' as any,
            );
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A9 — prose-wrapped JSON string must not silently drop',
        async () => {
            runSpy.mockResolvedValue(
                'Here is the result: {"codeSuggestions":[{"id":"s1","severity":"high"}]}\n\nLet me know.' as any,
            );
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A10 — right data under wrong top-level key {suggestions:[...]} must not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                suggestions: [{ id: 's1', severity: 'high' }],
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A11 — top-level key case mismatch {CodeSuggestions:[...]} must not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                CodeSuggestions: [{ id: 's1', severity: 'high' }],
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it('A12 — partial inner object (missing severity) is recovered, not dropped', async () => {
        runSpy.mockResolvedValue({
            codeSuggestions: [{ id: 's1' }],
        } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual([{ id: 's1' }]);
    });

    it('A13 — extra unknown keys alongside the right ones are tolerated (no crash, payload recovered)', async () => {
        runSpy.mockResolvedValue({
            codeSuggestions: [{ id: 's1', severity: 'high' }],
            extra: 'x',
            meta: { tokens: 10 },
        } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual([{ id: 's1', severity: 'high' }]);
    });

    it.failing(
        'A14 — empty object {} (truthy-but-invalid) must fall back to input, not silently drop',
        async () => {
            runSpy.mockResolvedValue({} as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A15 — bare empty array [] (off-schema envelope) must fall back to input, not silently drop',
        async () => {
            runSpy.mockResolvedValue([] as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it('A16 — empty string is falsy → fail-safe to the INPUT suggestions', async () => {
        runSpy.mockResolvedValue('' as any);
        const out = await runSeverity(buildService());
        expect(out).toBe(inputSuggestions);
    });

    it('A17 — null / undefined return is falsy → fail-safe to the INPUT suggestions', async () => {
        runSpy.mockResolvedValue(undefined as any);
        const out = await runSeverity(buildService());
        expect(out).toBe(inputSuggestions);
    });

    it.failing(
        'A18a — primitive true (truthy, off-schema) must not silently drop to []',
        async () => {
            runSpy.mockResolvedValue(true as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it('A18b — primitive 0 is falsy → fail-safe to the INPUT suggestions', async () => {
        runSpy.mockResolvedValue(0 as any);
        const out = await runSeverity(buildService());
        expect(out).toBe(inputSuggestions);
    });

    it.failing(
        'A19 — provider envelope leak {choices:[{message:{content}}]} must not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                choices: [
                    {
                        message: {
                            content:
                                '{"codeSuggestions":[{"id":"s1","severity":"high"}]}',
                        },
                    },
                ],
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it.failing(
        'A20 — reasoning/thinking leak in content must not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                reasoning: '<thinking>weighing severities…</thinking>',
                content:
                    '{"codeSuggestions":[{"id":"s1","severity":"high"}]}',
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    // ── B. Semantic-but-wrong ──────────────────────────────────────────────

    it('B24 — out-of-set severity value is tolerated at the boundary (enum policing is downstream)', async () => {
        runSpy.mockResolvedValue({
            codeSuggestions: [{ id: 's1', severity: 'URGENT' }],
        } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual([{ id: 's1', severity: 'URGENT' }]);
    });

    it('B25 — a dangling id (not present in the input) is passed through unchanged, no join/crash at the boundary', async () => {
        runSpy.mockResolvedValue({
            codeSuggestions: [{ id: 'does-not-exist', severity: 'high' }],
        } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual([{ id: 'does-not-exist', severity: 'high' }]);
    });

    it('B27 — unicode / emoji / escaped newlines inside string fields are preserved', async () => {
        const payload = [
            { id: 's1', severity: 'high 🚀 世界\nline2' },
        ];
        runSpy.mockResolvedValue({ codeSuggestions: payload } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual(payload);
    });

    // ── C. Unparseable / transport (the fail-safe layer) ───────────────────

    it.failing(
        'C28 — truncated JSON string (max_tokens mid-object) must fall back, not silently drop',
        async () => {
            runSpy.mockResolvedValue(
                '{"codeSuggestions":[{"id":"s1","severity":"hi' as any,
            );
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it(
        'C29 — malformed JSON string (trailing comma / single quotes) must fall back, not silently drop',
        async () => {
            runSpy.mockResolvedValue(
                "{'codeSuggestions':[{'id':'s1','severity':'high',},],}" as any,
            );
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it('C30 — LLM.run throwing (network/timeout) fails safe to the INPUT suggestions, never past the boundary', async () => {
        runSpy.mockRejectedValue(new Error('ECONNRESET'));
        const out = await runSeverity(buildService());
        expect(out).toBe(inputSuggestions);
    });

    it.failing(
        'C31 — an {error:...} object returned instead of throwing must fall back to input, not silently drop',
        async () => {
            runSpy.mockResolvedValue({
                error: 'rate_limited',
                code: 429,
            } as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it('C32 — on-schema empty success {codeSuggestions:[]} is trusted and returned as []', async () => {
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual([]);
    });

    it.failing(
        'C33 — a refusal prose string ("I cannot help…") must fall back to input, not silently drop',
        async () => {
            runSpy.mockResolvedValue(
                'I cannot help with that request.' as any,
            );
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it('C34 — an abort/cancellation error fails safe to the INPUT suggestions', async () => {
        const abortErr = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
        });
        runSpy.mockRejectedValue(abortErr);
        const out = await runSeverity(buildService());
        expect(out).toBe(inputSuggestions);
    });

    // ── D. Input variants (happy LLM.run mock, assert the assembly invariant) ──

    it('D35 — empty input: still issues exactly one call and returns without crashing', async () => {
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        const out = await runSeverity(buildService(), []);
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(runSpy.mock.calls[0][0].user).toBe(
            prompt_severity_analysis_user([]),
        );
        expect(Array.isArray(out)).toBe(true);
    });

    it('D36 — single item is forwarded verbatim in one call', async () => {
        const single = [{ id: 'only', severity: 'low' }] as any[];
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        await runSeverity(buildService(), single);
        expect(runSpy.mock.calls[0][0].user).toBe(
            prompt_severity_analysis_user(single),
        );
    });

    it('D37 — large input is sent in ONE call with every item (no client-side batching/chunking)', async () => {
        const large = Array.from({ length: 500 }, (_, i) => ({
            id: `s${i}`,
            severity: 'low',
        })) as any[];
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        await runSeverity(buildService(), large);
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(runSpy.mock.calls[0][0].user).toBe(
            prompt_severity_analysis_user(large),
        );
    });

    it('D38 — duplicate items in the input are forwarded as-is (no dedup at this boundary)', async () => {
        const dup = [
            { id: 'same', severity: 'low' },
            { id: 'same', severity: 'low' },
        ] as any[];
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        await runSeverity(buildService(), dup);
        expect(runSpy.mock.calls[0][0].user).toBe(
            prompt_severity_analysis_user(dup),
        );
    });

    it('D39 — an input item with null/undefined fields does not crash assembly', async () => {
        const withNulls = [
            { id: null, severity: undefined },
            { id: 's2', severity: 'low' },
        ] as any[];
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        await expect(
            runSeverity(buildService(), withNulls),
        ).resolves.toBeDefined();
        expect(runSpy).toHaveBeenCalledTimes(1);
    });

    it('D40 — special chars / emoji / whitespace-only patch are threaded into the request unmodified (validateImplemented)', async () => {
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        const service = buildService();
        jest.spyOn(
            (service as any).llmResponseProcessor,
            'processResponse',
        ).mockReturnValue({ codeSuggestions: [] });
        const weirdPatch = '  \t\n@@ -1 +1 @@\n- 💥 café \\n <script> ';
        await service.validateImplementedSuggestions(
            org,
            77,
            undefined,
            weirdPatch,
            inputSuggestions,
        );
        expect(runSpy.mock.calls[0][0].user).toBe(
            prompt_validateImplementedSuggestions({
                codePatch: weirdPatch,
                codeSuggestions: inputSuggestions,
            }),
        );
    });

    it('D42 — order permutation is preserved (order-preserving assembly, no reorder/loss)', async () => {
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        const a = [
            { id: 'a', severity: 'low' },
            { id: 'b', severity: 'low' },
        ] as any[];
        const b = [a[1], a[0]];
        await runSeverity(buildService(), a);
        await runSeverity(buildService(), b);
        expect(runSpy.mock.calls[0][0].user).toBe(
            prompt_severity_analysis_user(a),
        );
        expect(runSpy.mock.calls[1][0].user).toBe(
            prompt_severity_analysis_user(b),
        );
    });

    // ── E. N-model policy (delegated) ──────────────────────────────────────
    // This boundary does NOT branch on provider — it threads whatever slot it is
    // given into LLM.run and applies the SAME processResponse parse regardless of
    // the structured-output-gate policy. So: (1) the slot is forwarded verbatim
    // for both a strict-json_schema provider and a json_object-fallback provider,
    // and (2) the off-schema #1786 drop is IDENTICAL under both — strict policy
    // buys no protection at this layer, and the fallback zoo is fully in scope.
    const strictSlot = { provider: 'openai', model: 'gpt-4o' } as any; // json_schema
    const fallbackSlot = { provider: 'deepseek', model: 'deepseek-chat' } as any; // json_object

    it('E — forwards the given slot verbatim to LLM.run (strict provider)', async () => {
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        await buildService().severityAnalysisAssignment(
            org,
            77,
            inputSuggestions,
            strictSlot,
        );
        expect(runSpy.mock.calls[0][0].byokConfig).toBe(strictSlot);
    });

    it('E — forwards the given slot verbatim to LLM.run (json_object-fallback provider)', async () => {
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        await buildService().severityAnalysisAssignment(
            org,
            77,
            inputSuggestions,
            fallbackSlot,
        );
        expect(runSpy.mock.calls[0][0].byokConfig).toBe(fallbackSlot);
    });

    for (const [label, slot] of [
        ['strict json_schema', strictSlot],
        ['json_object fallback', fallbackSlot],
    ] as const) {
        it.failing(
            `E — off-schema wrapper envelope silently drops identically under ${label} (parse layer is provider-agnostic)`,
            async () => {
                runSpy.mockResolvedValue({
                    result: {
                        codeSuggestions: [{ id: 's1', severity: 'high' }],
                    },
                } as any);
                const out = await buildService().severityAnalysisAssignment(
                    org,
                    77,
                    inputSuggestions,
                    slot,
                );
                expect(out).not.toEqual([]);
            },
        );
    }
});
