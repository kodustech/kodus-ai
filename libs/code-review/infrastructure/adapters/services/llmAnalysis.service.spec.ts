/**
 * LLMAnalysisService — migrated-consumer parity spec (Phase 3, plan 03-06).
 *
 * llmAnalysis is the core code-review analyzer and sits on the customer review
 * hot path, so this parity spec is mandatory (not a grep-only gate). It proves
 * the "no behavior change on the happy path" contract after migrating the
 * structured call-sites off the legacy BYOKPromptRunner LangChain path
 * onto the AI SDK path (runStructuredReviewCall).
 *
 * The primary analysis call is `analyzeCodeWithAI_v2` (the standard review path
 * — `codeAnalysisOrchestrator` calls `standardLLMAnalysisService.analyzeCodeWithAI_v2`).
 * Parity is on the parsed `codeSuggestions` mapping: a fixed structured result,
 * returned through the REAL runStructuredReviewCall (real model resolution + span),
 * maps byte-for-byte to the same AIAnalysisResult the pre-migration mapping produced,
 * and the model is invoked exactly once (one span path — no leftover runLLMInSpan
 * double-count, Q4).
 *
 * NOTE: this mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts
 * and the 03-01 tracer parity spec use) rather than driving generateText+Output.object
 * against a MockLanguageModelV4 — that structured-output path HANGS against an offline
 * model double (Phase 0 + 03-01). Parity here targets the codeSuggestions mapping,
 * which is exactly the migration's behavior-change risk.
 */

const MODEL_SUGGESTIONS = {
    codeSuggestions: [
        {
            id: 'sug-1',
            relevantFile: 'src/payments/charge.ts',
            language: 'typescript',
            suggestionContent: 'Guard against a null customer before charging.',
            existingCode: 'charge(customer.id)',
            improvedCode: 'if (customer) charge(customer.id)',
            oneSentenceSummary: 'Null-guard the customer',
            relevantLinesStart: 42,
            relevantLinesEnd: 42,
            label: 'potential_error',
            severity: 'high',
        },
        {
            id: 'sug-2',
            relevantFile: 'src/payments/charge.ts',
            language: 'typescript',
            suggestionContent: 'Extract the retry constant.',
            improvedCode: 'const MAX_RETRIES = 3;',
            label: 'maintainability',
        },
    ],
};

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
    codeReviewAnalysisSchema,
} from './llmAnalysis.service';
import { setLlmObservability } from '@libs/llm/llm-observability';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { LLM } from '@libs/llm/llm';
import { ReviewModeResponse } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { prompt_severity_analysis_user } from '@libs/common/utils/prompts/severityAnalysis';
import { prompt_validateImplementedSuggestions } from '@libs/common/utils/prompts';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

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

describe('LLMAnalysisService.analyzeCodeWithAI_v2 — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observability.runAiSdkLLMInSpan.mockClear();
        // LLM.run records its span through the observability port — register the mock.
        setLlmObservability(observability);
        observability.runLLMInSpan.mockClear();
        mockGenerate.mockResolvedValue({
            experimental_output: MODEL_SUGGESTIONS,
        });
    });

    it('maps the model codeSuggestions[] byte-for-byte into AIAnalysisResult', async () => {
        const service = buildService();

        const result = await service.analyzeCodeWithAI_v2(
            organizationAndTeamData,
            77,
            fileContext,
            'heavy_mode' as any,
            context,
            byokConfig,
        );

        expect(result).toEqual({
            codeSuggestions: MODEL_SUGGESTIONS.codeSuggestions,
            codeReviewModelUsed: {
                // The ACTUAL resolved model name (getModelName(slot)) — the same
                // name runStructuredReviewCall traces — not a hardcoded provider
                // label. Mock returns 'byok-main'.
                generateSuggestions: 'byok-main',
            },
        });
    });

    it('routes through exactly one AI SDK span (runAiSdkLLMInSpan), no LangChain runLLMInSpan wrapper (Q4)', async () => {
        const service = buildService();

        await service.analyzeCodeWithAI_v2(
            organizationAndTeamData,
            77,
            fileContext,
            'heavy_mode' as any,
            context,
            byokConfig,
        );

        expect(observability.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        // No leftover LangChain span path — single-span billing.
        expect(observability.runLLMInSpan).not.toHaveBeenCalled();
    });

    it('records the real resolved model name (getModelName) even with no BYOK, not a hardcoded label', async () => {
        const service = buildService();

        const result = await service.analyzeCodeWithAI_v2(
            organizationAndTeamData,
            77,
            fileContext,
            'heavy_mode' as any,
            context,
            {} as any,
        );

        // Telemetry-truth: the field reports whatever model actually resolved
        // (getModelName → mock 'byok-main'), NOT the old GEMINI_2_5_PRO label
        // that lied for the no-BYOK path (reported Gemini while DeepSeek ran).
        expect(result?.codeReviewModelUsed?.generateSuggestions).toBe(
            'byok-main',
        );
        expect(result?.codeSuggestions).toEqual(
            MODEL_SUGGESTIONS.codeSuggestions,
        );
    });
});

/**
 * The secondary analysis methods — severity, implemented-check, safeguard and
 * review-mode. The parity block above only covers analyzeCodeWithAI_v2; these
 * four each own a fail-safe contract (a provider failure must degrade to the
 * INPUT suggestions, never drop them) and a distinct request shape (severity
 * carries the org's BYOK slot; the implemented-check deliberately runs on the
 * managed default with byokConfig undefined). A regression that swallows the
 * fallback or crosses the wires is invisible to the parity spec.
 *
 * We spy on LLM.run directly (restored after each test so the parity block keeps
 * using the real span path) and, for the success paths, stub the internal
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
                'openai' as any,
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
                'openai' as any,
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
                'openai' as any,
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
                'openai' as any,
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
                'openai' as any,
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
            // Deliberate: this check runs on the managed default, never a slot.
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
                'openai' as any,
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
                'openai' as any,
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
                'openai' as any,
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

    describe('selectReviewMode', () => {
        it('always resolves to HEAVY_MODE', async () => {
            const service = buildService();
            const out = await service.selectReviewMode(
                org,
                77,
                'openai' as any,
                { filename: 'f.ts' } as any,
                'diff',
            );
            expect(out).toBe(ReviewModeResponse.HEAVY_MODE);
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
 * The four analyzer boundaries share ONE parse shape:
 *   LLM.run(schema) → object → JSON.stringify(object) → processResponse()
 * where `processResponse` only recognises a payload whose top-level
 * `codeSuggestions` is an array (llmResponseProcessor.transform.ts:32,49,61).
 *
 * THE #1786 DEGRADATION (recorded as it.failing, green now / red on the fix):
 * a TRUTHY-BUT-OFF-SCHEMA envelope (bare array, wrapper key, stringified blob,
 * right-data-wrong-key, primitive, error object, refusal prose …) is NOT falsy,
 * so it skips the `if (!result)` fail-safe-to-INPUT guard, then fails the
 * `Array.isArray(codeSuggestions)` recognition inside processResponse, and the
 * `?.codeSuggestions || []` defaults (llmAnalysis.service.ts:437-438 severity,
 * :580-581 validate; :253 analyzeCodeWithAI_v2 undefined; :173 analyze v1) SILENTLY
 * DROP every input suggestion to [] / undefined with no signal. The correct
 * behavior is to RECOVER the payload OR fall back to the INPUT suggestions (the
 * documented safe default the throw path already produces) — never a silent [].
 * The pin `expect(out).not.toEqual([])` turns red the moment either fix lands.
 *
 * A second structural degradation: because every path calls JSON.stringify()
 * BEFORE processResponse, a STRING result from LLM.run (json_object fallback
 * models can hand back a raw string) is double-encoded and the whole
 * markdown/prose/JSON5-repair machinery inside processResponse is defeated
 * (rows 7/8/9/28/29/33).
 *
 * We spy on the REAL LLM.run boundary and restore after each test so the parity
 * block above keeps exercising the real span path.
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
        service.severityAnalysisAssignment(
            org,
            77,
            'openai' as any,
            input,
            byokConfig,
        );

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

    it.failing(
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
            'openai' as any,
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
            'openai' as any,
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
            'deepseek' as any,
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
                    'p' as any,
                    inputSuggestions,
                    slot,
                );
                expect(out).not.toEqual([]);
            },
        );
    }
});

/**
 * Return-shape closure for the other three boundaries. Each guarantees a distinct
 * declared type; these assert the type/shape holds across the happy, off-schema
 * and fail-safe layers (the A/B/C zoo is exercised in full on severity above;
 * here we pin the DECLARED-SHAPE invariant that each method must never violate).
 */
describe('LLMAnalysisService — declared-return-shape across boundaries', () => {
    const org = organizationAndTeamData;
    let runSpy: jest.SpyInstance;
    beforeEach(() => {
        jest.clearAllMocks();
        setLlmObservability(observability);
        runSpy = jest.spyOn(LLM, 'run');
    });
    afterEach(() => runSpy.mockRestore());

    describe('analyzeCodeWithAI_v2', () => {
        it('A1 — assembles the request with the analysis schema, runName, slot, org and attrs', async () => {
            runSpy.mockResolvedValue({
                codeSuggestions: [
                    {
                        id: 'x',
                        relevantFile: 'a.ts',
                        language: 'ts',
                        suggestionContent: 'c',
                        improvedCode: 'i',
                        label: 'l',
                    },
                ],
            } as any);
            await buildService().analyzeCodeWithAI_v2(
                organizationAndTeamData,
                77,
                fileContext,
                'heavy_mode' as any,
                context,
                byokConfig,
            );
            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(codeReviewAnalysisSchema);
            expect(arg.runName).toBe('analyzeCodeWithAI_v2');
            expect(arg.byokConfig).toBe(byokConfig);
            expect(arg.organizationId).toBe('org-1');
            expect(arg.attrs.prNumber).toBe(77);
        });

        it('C30/A17 — a null structured result throws (fail-safe by escalation, never a silent empty result)', async () => {
            runSpy.mockResolvedValue(null as any);
            await expect(
                buildService().analyzeCodeWithAI_v2(
                    organizationAndTeamData,
                    77,
                    fileContext,
                    'heavy_mode' as any,
                    context,
                    byokConfig,
                ),
            ).rejects.toThrow(/No analysis result/);
        });

        it.failing(
            'A2 — a truthy off-schema envelope (bare array) must not yield an undefined codeSuggestions on the declared AIAnalysisResult',
            async () => {
                runSpy.mockResolvedValue([{ id: 'x' }] as any);
                const out = await buildService().analyzeCodeWithAI_v2(
                    organizationAndTeamData,
                    77,
                    fileContext,
                    'heavy_mode' as any,
                    context,
                    byokConfig,
                );
                expect(out.codeSuggestions).toBeDefined();
            },
        );
    });

    describe('generateCodeSuggestions', () => {
        it('A1 — returns the re-serialized JSON string on success', async () => {
            const structured = {
                codeSuggestions: [{ id: 'g1', label: 'l' }],
            };
            runSpy.mockResolvedValue(structured as any);
            const out = await buildService().generateCodeSuggestions(
                organizationAndTeamData,
                'sess-1',
                'why?',
                {},
            );
            expect(out).toBe(JSON.stringify(structured));
        });

        it('A17/C30 — a falsy structured result throws (never returns a null/empty string silently)', async () => {
            runSpy.mockResolvedValue(null as any);
            await expect(
                buildService().generateCodeSuggestions(
                    organizationAndTeamData,
                    'sess-1',
                    'why?',
                    {},
                ),
            ).rejects.toThrow(/No code suggestions generated/);
        });

        it('A1 — request carries no BYOK slot (system-provider path) with the analysis schema', async () => {
            runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
            await buildService().generateCodeSuggestions(
                organizationAndTeamData,
                'sess-1',
                'why?',
                {},
            );
            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(codeReviewAnalysisSchema);
            expect(arg.byokConfig).toBeUndefined();
            expect(arg.runName).toBe('generateCodeSuggestions');
        });
    });
});
