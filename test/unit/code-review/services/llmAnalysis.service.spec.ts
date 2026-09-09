import { LLMAnalysisService } from '@/code-review/infrastructure/adapters/services/llmAnalysis.service';
import { SafeguardPipelineService } from '@/code-review/infrastructure/adapters/services/safeguardPipeline.service';
import { ReviewModeResponse } from '@/core/infrastructure/config/types/general/codeReview.type';
import { ObservabilityService } from '@/core/log/observability.service';
import { SANDBOX_PROVIDER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { LLM } from '@libs/llm/llm';
import { Test, TestingModule } from '@nestjs/testing';

// The service was migrated off the LangChain PromptRunner onto the AI SDK
// `LLM.run` seam. Mock that seam so these unit tests are deterministic and NEVER
// touch a real model/network — otherwise, whenever a valid LLM key happens to be
// in the env, the real call succeeds and the "returns original on error" paths
// never fire (the old PromptRunner mock below is dead: the service no longer
// calls it).
jest.mock('@libs/llm/llm', () => ({
    LLM: { run: jest.fn() },
}));
const mockLLMRun = LLM.run as jest.Mock;

// Mock logger to silence logs during tests
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('LLMAnalysisService', () => {
    let service: LLMAnalysisService;

    const mockObservabilityService = {
        runLLMInSpan: jest.fn(async ({ exec }) => {
            return exec([]);
        }),
    };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const mockSafeguardPipelineService = {
        execute: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LLMAnalysisService,
                {
                    provide: ObservabilityService,
                    useValue: mockObservabilityService,
                },
                {
                    provide: SANDBOX_PROVIDER_TOKEN,
                    useValue: {
                        isAvailable: jest.fn().mockReturnValue(false),
                        createSandboxWithRepo: jest.fn(),
                    },
                },
                {
                    provide: SafeguardPipelineService,
                    useValue: mockSafeguardPipelineService,
                },
            ],
        }).compile();

        service = module.get<LLMAnalysisService>(LLMAnalysisService);
        jest.clearAllMocks();
    });

    describe('validateImplementedSuggestions', () => {
        it('should return original suggestions on error', async () => {
            mockLLMRun.mockRejectedValue(new Error('LLM error'));

            const suggestions = [
                { id: 's1', suggestionContent: 'Original suggestion' },
            ];

            const result = await service.validateImplementedSuggestions(
                mockOrganizationAndTeamData as any,
                123,
                undefined,
                '@@ -1,1 +1,1 @@',
                suggestions,
            );

            expect(result).toEqual(suggestions);
        });
    });

    describe('severityAnalysisAssignment', () => {
        it('should return original suggestions on error', async () => {
            mockLLMRun.mockRejectedValue(new Error('LLM error'));

            const suggestions = [{ id: 's1', severity: 'unknown' }];

            const result = await service.severityAnalysisAssignment(
                mockOrganizationAndTeamData as any,
                123,
                suggestions as any,
                {} as any,
            );

            expect(result).toEqual(suggestions);
        });
    });

    describe('filterSuggestionsSafeGuard', () => {
        it('should remove suggestionEmbedded from suggestions before processing', async () => {
            const suggestions = [
                {
                    id: 's1',
                    suggestionContent: 'test',
                    suggestionEmbedded: [0.1, 0.2, 0.3], // Should be removed
                },
            ];

            mockSafeguardPipelineService.execute.mockResolvedValue({
                suggestions,
            });

            // After the function runs, suggestionEmbedded should be deleted
            await service.filterSuggestionsSafeGuard(
                mockOrganizationAndTeamData as any,
                123,
                { filename: 'test.ts', fileContent: 'code' },
                'relevant',
                '@@ -1,1 +1,1 @@',
                suggestions,
                'en',
                ReviewModeResponse.HEAVY_MODE,
                {} as any,
            );

            // Verify the suggestion no longer has suggestionEmbedded
            expect(suggestions[0]).not.toHaveProperty('suggestionEmbedded');
        });

        it('should return original suggestions on error', async () => {
            const suggestions = [{ id: 's1', suggestionContent: 'original' }];
            mockSafeguardPipelineService.execute.mockRejectedValue(
                new Error('LLM error'),
            );

            const result = await service.filterSuggestionsSafeGuard(
                mockOrganizationAndTeamData as any,
                123,
                { filename: 'test.ts' },
                '',
                '@@ -1,1 +1,1 @@',
                suggestions,
                'en',
                ReviewModeResponse.HEAVY_MODE,
                {} as any,
            );

            expect(result.suggestions).toEqual(suggestions);
        });
    });

});
