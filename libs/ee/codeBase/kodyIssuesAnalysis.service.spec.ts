/**
 * Parity spec for the runStructuredReviewCall migration (03-05).
 *
 * Same seam-mock strategy as structured-review-call.spec.ts: mock
 * tracedGenerateText so the real runStructuredReviewCall runs but no provider
 * is hit (MockLanguageModelV4 hangs on the structured path). The assertions
 * prove the migrated merge/resolve sites return the same parsed object shapes
 * the STRING parser produced, which the downstream KodyIssuesManagementService
 * consumes via `?.matches` / `?.issueVerificationResults`.
 */
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
    toAiSdkTelemetryArgs: jest.fn(() => ({
        telemetry: { isEnabled: false },
    })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
}));

import { KodyIssuesAnalysisService } from './kodyIssuesAnalysis.service';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

describe('KodyIssuesAnalysisService — runStructuredReviewCall parity', () => {
    let service: KodyIssuesAnalysisService;

    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });

    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();

        service = new KodyIssuesAnalysisService(
            {} as any, // promptRunnerService (DI-only, unused after migration)
            observabilityService,
        );
    });

    it('mergeSuggestionsIntoIssues returns the parsed matches object', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                matches: [
                    { suggestionId: 's1', existingIssueId: 'i1' },
                    { suggestionId: 's2', existingIssueId: null },
                ],
            }),
        );

        const out = await service.mergeSuggestionsIntoIssues(
            { organizationId: 'org-1' } as any,
            { number: 42 },
            { filePath: 'a.ts', existingIssues: [], newSuggestions: [] },
            null,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out.matches).toHaveLength(2);
        expect(out.matches[0]).toEqual({
            suggestionId: 's1',
            existingIssueId: 'i1',
        });
        // `null` (no match) survives so the consumer's `if (existingIssueId)`
        // guard behaves exactly as under the old STRING parser.
        expect(out.matches[1].existingIssueId).toBeNull();
    });

    it('resolveExistingIssues returns the parsed issueVerificationResults object', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                issueVerificationResults: [
                    {
                        issueId: 'i1',
                        issueTitle: 'Null check',
                        contributingSuggestionIds: ['s1'],
                        isIssuePresentInCode: false,
                        verificationConfidence: 'high',
                        reasoning: 'fixed',
                    },
                ],
            }),
        );

        const context = {
            organizationAndTeamData: { organizationId: 'org-1' },
            repository: { id: 'repo-1' },
            pullRequest: { number: 42 },
        } as any;

        const out = await service.resolveExistingIssues(
            context,
            { filePath: 'a.ts', issues: [] },
            null,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out.issueVerificationResults).toHaveLength(1);
        expect(out.issueVerificationResults[0].issueId).toBe('i1');
        expect(out.issueVerificationResults[0].isIssuePresentInCode).toBe(
            false,
        );
    });

    it('propagates the error when the LLM call fails (no silent swallow)', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('provider down'));

        await expect(
            service.mergeSuggestionsIntoIssues(
                { organizationId: 'org-1' } as any,
                { number: 42 },
                { filePath: 'a.ts' },
                // BYOK config with no fallback → main failure must throw,
                // never cascade to managed Groq.
                { main: { provider: 'openai' } } as any,
            ),
        ).rejects.toThrow('provider down');
    });
});
