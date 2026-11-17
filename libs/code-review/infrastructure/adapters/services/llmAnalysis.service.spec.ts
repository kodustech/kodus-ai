/**
 * LLMAnalysisService — migrated-consumer parity spec (Phase 3, plan 03-06).
 *
 * llmAnalysis sits on the customer review hot path for its surviving methods
 * (severityAnalysisAssignment, checkSuggestionImplementation,
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
    implementationCheckSchema,
} from './llmAnalysis.service';
import { setLlmObservability } from '@libs/llm/llm-observability';
import { LLM } from '@libs/llm/llm';
import { zodToStrictWireSchema } from '@libs/llm/strict-wire-schema';
import { ReviewModeResponse } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { prompt_severity_analysis_user } from '@libs/common/utils/prompts/severityAnalysis';
import { prompt_checkSuggestionImplementation } from '@libs/common/utils/prompts';

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
 * Each owns a fail-safe contract and a distinct request shape. Severity and
 * safeguard degrade to the INPUT suggestions on a provider failure, never
 * dropping them. The implementation check reports every suggestion it could not
 * decide as unmeasured, never echoing its input, which used to read as "not
 * implemented". Severity carries the org's BYOK slot; the implementation check
 * runs on whatever slot the caller resolves (`undefined` when the org has none
 * configured for the task), never a hardcoded provider. A regression that
 * swallows the fallback or crosses the wires is invisible elsewhere.
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

    describe('checkSuggestionImplementation', () => {
        const file = { filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' };
        const asked = [
            {
                id: 's1',
                relevantLinesStart: 3,
                relevantLinesEnd: 4,
                problem: 'Use || instead of &&',
                existingCode: 'a && b',
                improvedCode: 'a || b',
            },
            {
                id: 's2',
                relevantLinesStart: 9,
                relevantLinesEnd: 9,
                problem: 'Escape the url',
                existingCode: 'url',
                improvedCode: '',
            },
        ];
        const check = (service: LLMAnalysisService, byok: any = undefined) =>
            service.checkSuggestionImplementation({
                organizationAndTeamData: org,
                prNumber: 77,
                byokConfig: byok,
                file,
                suggestions: asked,
            });

        it("runs on the caller's slot with the check's schema, prompt and billing runName, and no system prompt", async () => {
            runSpy.mockResolvedValue({ verdicts: [] });

            await check(buildService(), byokConfig);

            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(implementationCheckSchema);
            expect(arg.user).toBe(
                prompt_checkSuggestionImplementation({ file, suggestions: asked }),
            );
            // Token usage and billing are keyed on this runName
            // (token-usage-tu.ts, backfill-tu.ts).
            expect(arg.runName).toBe('validateImplementedSuggestions');
            expect(arg.byokConfig).toBe(byokConfig);
            // An explicit empty system block is rejected by some BYOK providers
            // (root cause of the 2026-09 implementation-rate incident).
            expect(arg.system).toBeUndefined();
        });

        it('returns each verdict normalized to one of the three statuses', async () => {
            runSpy.mockResolvedValue({
                verdicts: [
                    { id: 's1', implementationStatus: 'IMPLEMENTED' },
                    { id: 's2', implementationStatus: 'not implemented' },
                ],
            });

            const out = await check(buildService());

            expect(out).toEqual({
                verdicts: [
                    { id: 's1', status: 'implemented' },
                    { id: 's2', status: 'not_implemented' },
                ],
                unmeasured: [],
            });
        });

        it('marks a suggestion with an answer that is not a status as invalid_output, and keeps the others', async () => {
            runSpy.mockResolvedValue({
                verdicts: [
                    { id: 's1', implementationStatus: 'The patch fixes it.' },
                    { id: 's2', implementationStatus: 'partially_implemented' },
                ],
            });

            const out = await check(buildService());

            expect(out).toEqual({
                verdicts: [{ id: 's2', status: 'partially_implemented' }],
                unmeasured: [{ id: 's1', reason: 'invalid_output' }],
            });
        });

        it('marks a suggestion the model left out as omitted, and ignores ids it was not asked about', async () => {
            runSpy.mockResolvedValue({
                verdicts: [
                    { id: 's1', implementationStatus: 'implemented' },
                    { id: 'other', implementationStatus: 'implemented' },
                    { id: 's1', implementationStatus: 'not_implemented' },
                ],
            });

            const out = await check(buildService());

            expect(out).toEqual({
                verdicts: [{ id: 's1', status: 'implemented' }],
                unmeasured: [{ id: 's2', reason: 'omitted' }],
            });
        });

        // LLM.run validates through the strict wire schema, which drops null
        // properties before parsing.
        it('accepts an item whose status is null on the wire, so it costs that item only', async () => {
            const wire = zodToStrictWireSchema(implementationCheckSchema);

            const parsed = await wire.validate!({
                verdicts: [
                    { id: 's1', implementationStatus: 'implemented' },
                    { id: 's2', implementationStatus: null },
                ],
            });

            expect(parsed.success).toBe(true);
        });

        it('marks a suggestion answered with a null status invalid_output', async () => {
            runSpy.mockResolvedValue({
                verdicts: [
                    { id: 's1', implementationStatus: 'implemented' },
                    { id: 's2', implementationStatus: null },
                ],
            });

            const out = await check(buildService());

            expect(out).toEqual({
                verdicts: [{ id: 's1', status: 'implemented' }],
                unmeasured: [{ id: 's2', reason: 'invalid_output' }],
            });
        });

        it('marks every suggestion llm_error when the call fails, never echoing the input', async () => {
            runSpy.mockRejectedValue(new Error('boom'));

            const out = await check(buildService());

            expect(out).toEqual({
                verdicts: [],
                unmeasured: [
                    { id: 's1', reason: 'llm_error' },
                    { id: 's2', reason: 'llm_error' },
                ],
            });
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
