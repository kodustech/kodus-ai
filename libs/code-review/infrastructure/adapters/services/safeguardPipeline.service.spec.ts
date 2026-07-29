/**
 * Focused parity spec for the SafeguardPipelineService migration onto
 * runStructuredReviewCall (REQ-NOLC-01). Both structured call-sites (feature
 * extraction, prompt-only verification) and the multi-turn agent loop were moved
 * off the kodus-common LangChain PromptRunner onto the AI SDK path. These tests
 * pin that the safeguard VERDICT — which suggestions survive triage +
 * verification, and how improvedCode is nulled — is unchanged for representative
 * inputs. They mock the tracedGenerateText seam (like structured-review-call.spec.ts),
 * NOT the LangChain builder that no longer exists on this path.
 */

// --- runStructuredReviewCall seam mocks (mirror structured-review-call.spec.ts) ---
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(() => ({ __model: true })),
    getModelName: jest.fn(() => 'test-model'),
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
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
}));

import { tracedGenerateText } from '@libs/llm/llm-call';
import { SafeguardFeatureSet } from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguardFeatures';

import { SafeguardPipelineService } from './safeguardPipeline.service';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

/** Return the AI-SDK structured-call shape runStructuredReviewCall unwraps. */
const out = (obj: any) => ({ experimental_output: obj, usage: {} });

/** All 13 safeguard features default false; override the ones under test. */
const mkFeatures = (
    overrides: Partial<SafeguardFeatureSet>,
): SafeguardFeatureSet => ({
    has_resource_leak: false,
    has_inconsistent_contract: false,
    has_wrong_algorithm: false,
    has_data_exposure: false,
    has_missing_error_handling: false,
    has_redundant_work_in_loop: false,
    has_unsafe_data_flow: false,
    requires_assumed_input: false,
    requires_assumed_workload: false,
    is_quality_opinion: false,
    is_anti_pattern_only: false,
    targets_unchanged_code: false,
    improvedCode_is_correct: true,
    ...overrides,
});

const baseParams = (suggestions: any[], extra: Record<string, any> = {}) => ({
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    prNumber: 7,
    file: { filename: 'f.ts', fileContent: 'content' },
    relevantContent: 'content',
    codeDiff: '+ x',
    suggestions,
    languageResultPrompt: 'en-US',
    reviewMode: 'light_mode',
    // A BYOK config keeps runStructuredReviewCall on the main model (no managed
    // Groq trial fallback), so a single mocked resolve per call is deterministic.
    byokConfig: { main: { provider: 'openai', model: 'gpt-4o' } },
    ...extra,
});

describe('SafeguardPipelineService — structured-call parity', () => {
    let service: SafeguardPipelineService;
    let observability: any;

    beforeEach(() => {
        mockGenerate.mockReset();
        observability = {
            // runStructuredReviewCall runs its exec inside runAiSdkLLMInSpan and
            // reads experimental_output off the result.
            runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
            runLLMInSpan: jest.fn(),
        };
        service = new SafeguardPipelineService(
            observability,
            {} as any, // sandboxProvider
            {} as any, // documentationSearchExaService
        );
    });

    it('prompt-only path: discards quality-opinion in triage, keeps/drops structural defects by the verdict, and nulls incorrect improvedCode', async () => {
        const suggestions = [
            { id: 's1', suggestionContent: 'c1', improvedCode: 'orig1' },
            { id: 's2', suggestionContent: 'c2', improvedCode: 'orig2' },
            { id: 's3', suggestionContent: 'c3', improvedCode: 'orig3' },
            { id: 's4', suggestionContent: 'c4', improvedCode: 'orig4' },
        ];

        mockGenerate
            // 1) feature extraction — one call for all suggestions
            .mockResolvedValueOnce(
                out({
                    codeSuggestions: [
                        {
                            id: 's1',
                            features: mkFeatures({ is_quality_opinion: true }),
                        },
                        {
                            id: 's2',
                            features: mkFeatures({ has_resource_leak: true }),
                        },
                        {
                            id: 's3',
                            features: mkFeatures({ has_resource_leak: true }),
                        },
                        {
                            id: 's4',
                            features: mkFeatures({
                                has_resource_leak: true,
                                improvedCode_is_correct: false,
                            }),
                        },
                    ],
                }),
            )
            // 2) prompt-only verify s2 → keep
            .mockResolvedValueOnce(out({ verdict: true, evidence: 'real leak' }))
            // 3) prompt-only verify s3 → discard
            .mockResolvedValueOnce(out({ verdict: false, evidence: 'refuted' }))
            // 4) prompt-only verify s4 → keep (but improvedCode is wrong → null)
            .mockResolvedValueOnce(out({ verdict: true, evidence: 'real leak' }));

        // No remoteCommands → prompt-only verification path.
        const result = await service.execute(baseParams(suggestions) as any);

        expect(result.suggestions).toEqual([
            { id: 's2', suggestionContent: 'c2', improvedCode: 'orig2' },
            { id: 's4', suggestionContent: 'c4', improvedCode: null },
        ]);
        // One extraction + one verify per to-verify suggestion (s2, s3, s4).
        expect(mockGenerate).toHaveBeenCalledTimes(4);
        // Single-span AI SDK path — the legacy runLLMInSpan wrapper is gone (Q4).
        expect(observability.runLLMInSpan).not.toHaveBeenCalled();
    });

    it('agent path: flattened multi-turn loop keeps a suggestion the agent verifies as a real defect', async () => {
        const suggestions = [
            { id: 's1', suggestionContent: 'leak', improvedCode: 'orig1' },
        ];

        const remoteCommands = {
            grep: jest.fn().mockResolvedValue('match line'),
            read: jest.fn().mockResolvedValue('file body'),
            listDir: jest.fn().mockResolvedValue('dir listing'),
        };

        mockGenerate
            // 1) feature extraction → structural defect → triage 'verify'
            .mockResolvedValueOnce(
                out({
                    codeSuggestions: [
                        {
                            id: 's1',
                            features: mkFeatures({ has_resource_leak: true }),
                        },
                    ],
                }),
            )
            // 2) agent turn 0 — must make a tool call before any verdict
            .mockResolvedValueOnce(out({ tool: 'read', path: 'f.ts' }))
            // 3) agent turn 1 — verdict keep
            .mockResolvedValueOnce(
                out({
                    verdict: true,
                    action: 'no_changes',
                    evidence: 'confirmed real leak',
                }),
            );

        const result = await service.execute(
            baseParams(suggestions, { remoteCommands }) as any,
        );

        expect(result.suggestions).toEqual([
            { id: 's1', suggestionContent: 'leak', improvedCode: 'orig1' },
        ]);
        // The agent read the file exactly once (turn-0 tool call executed).
        expect(remoteCommands.read).toHaveBeenCalledTimes(1);
        // extraction + turn0 tool call + turn1 verdict.
        expect(mockGenerate).toHaveBeenCalledTimes(3);
    });

    it('feature extraction failure keeps all suggestions (safe default)', async () => {
        const suggestions = [
            { id: 's1', suggestionContent: 'c1' },
            { id: 's2', suggestionContent: 'c2' },
        ];

        // Every attempt fails → runStructuredReviewCall throws → extractFeatures
        // returns no features → the pipeline returns the input untouched.
        mockGenerate.mockRejectedValue(new Error('provider down'));

        const result = await service.execute(baseParams(suggestions) as any);

        expect(result.suggestions).toEqual(suggestions);
    });
});
