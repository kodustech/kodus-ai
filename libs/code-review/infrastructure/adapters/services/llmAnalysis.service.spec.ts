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
import { estimateTokens } from './utils/token-estimator';
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
            // No system prompt at all (not even ''): some BYOK providers reject
            // an explicit empty system content block outright (prod incident,
            // 2026-09-16) — LLM.run must see it unset to omit the field.
            expect(arg.system).toBeUndefined();
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
            // No system prompt at all (not even ''): some BYOK providers reject
            // an explicit empty system content block outright (prod incident,
            // 2026-09-16, root cause of the implementation_rate_pct drop) —
            // LLM.run must see it unset to omit the field.
            expect(arg.system).toBeUndefined();
        });

        it('splits an oversized diff into batches that each fit the BYOK slot', async () => {
            const bigPatch = (name: string) =>
                `File: ${name}\n${'+ const x = 1;\n'.repeat(1500)}`;
            const codePatch = [
                bigPatch('a.ts'),
                bigPatch('b.ts'),
                bigPatch('c.ts'),
                bigPatch('unrelated.ts'),
            ].join('\n\n');
            const sugg = [
                { id: 'a', relevantFile: 'a.ts' },
                { id: 'b', relevantFile: 'b.ts' },
                { id: 'c', relevantFile: 'c.ts' },
            ] as any[];
            const slot = { ...byokConfig, maxInputTokens: 12000 };
            runSpy.mockImplementation(async (arg: any) => ({
                codeSuggestions: [...sugg]
                    .filter((x) => arg.user.includes(`"${x.id}"`))
                    .map((x) => ({
                        id: x.id,
                        relevantFile: x.relevantFile,
                        implementationStatus: 'implemented',
                    })),
            }));
            const service = buildService();
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockImplementation((_o: any, _n: any, raw: string) =>
                JSON.parse(raw),
            );

            const out = await service.validateImplementedSuggestions(
                org,
                77,
                slot,
                codePatch,
                sugg,
            );

            expect(runSpy.mock.calls.length).toBeGreaterThan(1);
            for (const [arg] of runSpy.mock.calls) {
                expect(estimateTokens(arg.user)).toBeLessThanOrEqual(12000);
                expect(arg.user).not.toContain('unrelated.ts');
            }
            expect(out.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
        });

        it('cuts a single patch that alone exceeds the slot budget', async () => {
            const codePatch = `File: a.ts\n${'+ const x = 1;\n'.repeat(20000)}`;
            const sugg = [{ id: 'a', relevantFile: 'a.ts' }] as any[];
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockReturnValue({ codeSuggestions: [] });

            await service.validateImplementedSuggestions(
                org,
                77,
                { ...byokConfig, maxInputTokens: 12000 },
                codePatch,
                sugg,
            );

            expect(runSpy).toHaveBeenCalledTimes(1);
            expect(
                estimateTokens(runSpy.mock.calls[0][0].user),
            ).toBeLessThanOrEqual(12000);
        });

        it('measures the fixed prompt part per batch, not for all suggestions', async () => {
            const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
            const codePatch = files
                .map((f) => `File: ${f}\n${'+ const x = 1;\n'.repeat(500)}`)
                .join('\n\n');
            const sugg = files.flatMap((f) =>
                [1, 2, 3, 4, 5].map((n) => ({
                    id: `${f}-${n}`,
                    relevantFile: f,
                    suggestionContent: 'lorem ipsum '.repeat(300),
                })),
            ) as any[];
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockReturnValue({ codeSuggestions: [] });

            await service.validateImplementedSuggestions(
                org,
                77,
                { ...byokConfig, maxInputTokens: 12000 },
                codePatch,
                sugg,
            );

            // The payload with all suggestions overflows the slot, and every
            // batch must be sized with only its own suggestions.
            expect(runSpy.mock.calls.length).toBeGreaterThan(1);
            for (const [arg] of runSpy.mock.calls) {
                expect(estimateTokens(arg.user)).toBeLessThanOrEqual(12000);
            }
        });

        it('splits one file with many suggestions into requests that each fit the slot', async () => {
            const codePatch = `File: a.ts\n${'+ const x = 1;\n'.repeat(500)}`;
            const sugg = Array.from({ length: 40 }, (_, n) => ({
                id: `a-${n}`,
                relevantFile: 'a.ts',
                suggestionContent: 'lorem ipsum '.repeat(300),
            })) as any[];
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockReturnValue({ codeSuggestions: [] });

            await service.validateImplementedSuggestions(
                org,
                77,
                { ...byokConfig, maxInputTokens: 12000 },
                codePatch,
                sugg,
            );

            expect(runSpy.mock.calls.length).toBeGreaterThan(1);
            const seen = new Set<string>();
            for (const [arg] of runSpy.mock.calls) {
                expect(estimateTokens(arg.user)).toBeLessThanOrEqual(12000);
                for (const x of sugg) {
                    if (arg.user.includes(`"${x.id}"`)) seen.add(x.id);
                }
            }
            expect(seen.size).toBe(40);
        });

        it('makes no request when no suggestion has a patch section', async () => {
            const codePatch = `File: a.ts\n${'+ const x = 1;\n'.repeat(20000)}`;
            const sugg = [{ id: 'z', relevantFile: 'binary.png' }] as any[];
            runSpy.mockResolvedValue({ codeSuggestions: [] });
            const service = buildService();

            const out = await service.validateImplementedSuggestions(
                org,
                77,
                { ...byokConfig, maxInputTokens: 12000 },
                codePatch,
                sugg,
            );

            expect(runSpy).not.toHaveBeenCalled();
            expect(out).toEqual([]);
        });

        it('keeps the results of the batches that succeed when one batch throws', async () => {
            const bigPatch = (name: string) =>
                `File: ${name}\n${'+ const x = 1;\n'.repeat(1500)}`;
            const codePatch = ['a.ts', 'b.ts', 'c.ts']
                .map(bigPatch)
                .join('\n\n');
            const sugg = [
                { id: 'a', relevantFile: 'a.ts' },
                { id: 'b', relevantFile: 'b.ts' },
                { id: 'c', relevantFile: 'c.ts' },
            ] as any[];
            runSpy.mockImplementation(async (arg: any) => {
                if (arg.user.includes('"b"')) throw new Error('provider down');
                return {
                    codeSuggestions: sugg
                        .filter((x) => arg.user.includes(`"${x.id}"`))
                        .map((x) => ({
                            id: x.id,
                            relevantFile: x.relevantFile,
                            implementationStatus: 'implemented',
                        })),
                };
            });
            const service = buildService();
            jest.spyOn(
                (service as any).llmResponseProcessor,
                'processResponse',
            ).mockImplementation((_o: any, _n: any, raw: string) =>
                JSON.parse(raw),
            );

            const out = await service.validateImplementedSuggestions(
                org,
                77,
                { ...byokConfig, maxInputTokens: 12000 },
                codePatch,
                sugg,
            );

            expect(runSpy).toHaveBeenCalledTimes(3);
            expect(out.map((x) => x.id).sort()).toEqual(['a', 'c']);
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
                    [null, { id: 'x' }] as any[],
                    'en-US',
                    ReviewModeResponse.HEAVY_MODE,
                    byokConfig,
                ),
            ).resolves.toBeDefined();
        });

        it('is fail-safe: a pipeline failure returns the suggestions instead of dropping them', async () => {
            const execute = jest.fn().mockRejectedValue(new Error('pipeline'));
            const service = buildWithPipeline(execute);
            const input = [{ id: 'a' }] as any[];

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
    const runSeverity = (
        service: LLMAnalysisService,
        input = inputSuggestions,
    ) => service.severityAnalysisAssignment(org, 77, input, byokConfig);

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
            runSpy.mockResolvedValue([{ id: 's1', severity: 'high' }] as any);
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

    it('A12 — partial inner object (missing severity) is recovered, not dropped', async () => {
        runSpy.mockResolvedValue({
            codeSuggestions: [{ id: 's1' }],
        } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual([{ id: 's1' }]);
    });

    it.failing(
        'A14 — empty object {} (truthy-but-invalid) must fall back to input, not silently drop',
        async () => {
            runSpy.mockResolvedValue({} as any);
            const out = await runSeverity(buildService());
            expect(out).not.toEqual([]);
        },
    );

    it('C29 — malformed JSON string (trailing comma / single quotes) must fall back, not silently drop', async () => {
        runSpy.mockResolvedValue(
            "{'codeSuggestions':[{'id':'s1','severity':'high',},],}" as any,
        );
        const out = await runSeverity(buildService());
        expect(out).not.toEqual([]);
    });

    it('C32 — on-schema empty success {codeSuggestions:[]} is trusted and returned as []', async () => {
        runSpy.mockResolvedValue({ codeSuggestions: [] } as any);
        const out = await runSeverity(buildService());
        expect(out).toEqual([]);
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
});
