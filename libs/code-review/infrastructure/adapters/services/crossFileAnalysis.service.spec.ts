/**
 * Parity spec for the cross-file analysis migration onto runStructuredReviewCall.
 *
 * We mock the SAME low-level seams as structured-review-call.spec.ts — the model
 * builders and the `tracedGenerateText` generate seam — and let the REAL
 * runStructuredReviewCall run through the service. Driving the structured path
 * over `MockLanguageModelV4` HANGS (Phase 0 + 03-01), so we assert against a
 * mocked structured result at the generate seam instead.
 *
 * What "parity" means here: for the primary (BYOK-main) path, the service must
 *   1. call the structured seam on the org's BYOK main model,
 *   2. send the cross-file analysis prompt as `system` and the fixed analysis
 *      instruction as `user`, and
 *   3. map the structured `suggestions` array through the unchanged
 *      validate/enrich pipeline into CROSS_FILE CodeSuggestions.
 */

// --- Seam mocks (hoisted before the service graph loads) ---------------------
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(() => ({ __model: 'main' })),
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

import { CrossFileAnalysisService } from './crossFileAnalysis.service';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { LabelType } from '@libs/common/utils/codeManagement/labels';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result (one span path).
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const tokenChunkingService = {} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

describe('CrossFileAnalysisService — runStructuredReviewCall parity (primary path)', () => {
    let service: CrossFileAnalysisService;

    const byokConfig = {
        main: { provider: 'openai', model: 'gpt-4o' },
    } as any;

    const context: any = {
        codeReviewConfig: {
            byokConfig,
            v2PromptOverrides: undefined,
            kodyMemoryRules: [],
        },
        externalPromptContext: undefined,
    };

    const preparedFiles = [
        { filename: 'src/a.ts', patchWithLinesStr: '+ const a = 1;' },
        { filename: 'src/b.ts', patchWithLinesStr: '+ const b = 2;' },
    ];

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new CrossFileAnalysisService(
            tokenChunkingService,
            observabilityService,
        );
    });

    it('runs the structured call on the BYOK main model with the cross-file prompt as system + fixed user, and maps suggestions to CROSS_FILE', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                suggestions: [
                    {
                        relevantFile: 'src/a.ts',
                        relatedFile: 'src/b.ts',
                        language: 'typescript',
                        suggestionContent: 'Duplicated constant declaration.',
                        existingCode: 'const a = 1;',
                        improvedCode: 'export const SHARED = 1;',
                        oneSentenceSummary: 'Consolidate duplicated constant.',
                        relevantLinesStart: 1,
                        relevantLinesEnd: 1,
                        severity: 'high',
                    },
                ],
            }),
        );

        const result = await (service as any).processChunk(
            context,
            preparedFiles,
            'en-US',
            'gemini-2.5-pro',
            'analyzeCodeWithAI',
            0,
            123,
            organizationAndTeamData,
            undefined,
        );

        // One structured call, on the org's BYOK main model (not a fallback).
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        const callArgs = mockGenerate.mock.calls[0][0];
        expect(callArgs.model).toEqual({ __model: 'main' });

        // system = the cross-file analysis prompt (embeds the input files);
        // user = the fixed analysis instruction (parity with the old USER prompt).
        expect(callArgs.system).toContain('Cross-File Code Analysis');
        expect(callArgs.system).toContain('src/a.ts');
        expect(callArgs.prompt).toBe(
            'Please analyze the provided information and return the response in the specified format.',
        );

        // Output mapped through the unchanged validate/enrich pipeline.
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            relevantFile: 'src/a.ts',
            suggestionContent: 'Duplicated constant declaration.',
            severity: 'high',
            label: LabelType.CROSS_FILE,
        });
        expect(result[0].id).toEqual(expect.any(String));
    });

    it('drops suggestions missing required fields (validate parity)', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                suggestions: [
                    // missing suggestionContent → filtered out
                    {
                        relevantFile: 'src/a.ts',
                        relatedFile: 'src/b.ts',
                        language: 'typescript',
                        existingCode: 'const a = 1;',
                        improvedCode: '',
                        oneSentenceSummary: 'x',
                        relevantLinesStart: 1,
                        relevantLinesEnd: 1,
                        severity: 'low',
                    },
                ],
            }),
        );

        const result = await (service as any).processChunk(
            context,
            preparedFiles,
            'en-US',
            'gemini-2.5-pro',
            'analyzeCodeWithAI',
            0,
            123,
            organizationAndTeamData,
            undefined,
        );

        expect(result).toEqual([]);
    });
});
