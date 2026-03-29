import { Test, TestingModule } from '@nestjs/testing';
import { GetPullRequestSuggestionsUseCase } from '@/code-review/application/use-cases/pullRequests/get-pull-request-suggestions.use-case';
import { SUGGESTION_SERVICE_TOKEN } from '@/code-review/domain/contracts/SuggestionService.contract';
import { DeliveryStatus } from '@/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

describe('GetPullRequestSuggestionsUseCase', () => {
    let useCase: GetPullRequestSuggestionsUseCase;

    const mockSuggestionService = {
        filterActiveReviewSuggestions: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GetPullRequestSuggestionsUseCase,
                {
                    provide: SUGGESTION_SERVICE_TOKEN,
                    useValue: mockSuggestionService,
                },
            ],
        }).compile();

        useCase = module.get(GetPullRequestSuggestionsUseCase);
        jest.clearAllMocks();
    });

    it('returns only active file suggestions for the current iteration', async () => {
        const pr = {
            number: 42,
            provider: PlatformType.GITHUB,
            repository: {
                id: 'repo-123',
                name: 'repo',
                fullName: 'org/repo',
            },
            files: [
                {
                    path: 'src/index.ts',
                    suggestions: [
                        {
                            id: 'old-suggestion',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'medium',
                            label: 'bug',
                            oneSentenceSummary: 'Old suggestion',
                            comment: {
                                id: 101,
                                pullRequestReviewId: 1001,
                            },
                        },
                        {
                            id: 'current-suggestion',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'critical',
                            label: 'bug',
                            oneSentenceSummary: 'Current suggestion',
                            comment: {
                                id: 202,
                                pullRequestReviewId: 1002,
                            },
                        },
                    ],
                },
            ],
            prLevelSuggestions: [
                {
                    id: 'pr-level',
                    deliveryStatus: DeliveryStatus.SENT,
                    severity: 'low',
                    label: 'architecture',
                    oneSentenceSummary: 'PR level suggestion',
                },
            ],
        };

        mockSuggestionService.filterActiveReviewSuggestions.mockResolvedValue([
            {
                id: 'current-suggestion',
                deliveryStatus: DeliveryStatus.SENT,
                severity: 'critical',
                label: 'bug',
                oneSentenceSummary: 'Current suggestion',
                comment: {
                    id: 202,
                    pullRequestReviewId: 1002,
                },
                filePath: 'src/index.ts',
            },
        ]);

        const result = await useCase.execute({
            organizationId: 'org-123',
            pr,
            format: 'json',
        });

        expect(result.response).toEqual({
            prNumber: 42,
            repositoryId: 'repo-123',
            repositoryFullName: 'org/repo',
            suggestions: {
                files: [
                    expect.objectContaining({
                        id: 'current-suggestion',
                        filePath: 'src/index.ts',
                    }),
                ],
                prLevel: [
                    expect.objectContaining({
                        id: 'pr-level',
                    }),
                ],
            },
        });
        expect(result.suggestionsCount).toBe(2);
        expect(
            mockSuggestionService.filterActiveReviewSuggestions,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: { organizationId: 'org-123' },
            repository: { id: 'repo-123', name: 'repo' },
            prNumber: 42,
            platformType: PlatformType.GITHUB,
            suggestions: [
                expect.objectContaining({
                    id: 'old-suggestion',
                    filePath: 'src/index.ts',
                }),
                expect.objectContaining({
                    id: 'current-suggestion',
                    filePath: 'src/index.ts',
                }),
            ],
        });
    });

    it('returns markdown when requested', async () => {
        mockSuggestionService.filterActiveReviewSuggestions.mockResolvedValue([
            {
                id: 'current-suggestion',
                deliveryStatus: DeliveryStatus.SENT,
                severity: 'critical',
                label: 'bug',
                oneSentenceSummary: 'Current suggestion',
                suggestionContent: 'Fix it',
                relevantLinesStart: 10,
                relevantLinesEnd: 12,
                filePath: 'src/index.ts',
            },
        ]);

        const result = await useCase.execute({
            organizationId: 'org-123',
            pr: {
                number: 42,
                provider: PlatformType.GITHUB,
                repository: {
                    id: 'repo-123',
                    name: 'repo',
                    fullName: 'org/repo',
                },
                files: [
                    {
                        path: 'src/index.ts',
                        suggestions: [
                            {
                                id: 'current-suggestion',
                                deliveryStatus: DeliveryStatus.SENT,
                                severity: 'critical',
                                label: 'bug',
                                oneSentenceSummary: 'Current suggestion',
                                suggestionContent: 'Fix it',
                            },
                        ],
                    },
                ],
                prLevelSuggestions: [],
            },
            format: 'markdown',
            severity: 'critical',
        });

        expect(result.response).toHaveProperty('markdown');
        expect(result.response.markdown).toContain('# Suggestions for PR #42');
        expect(result.response.markdown).toContain('severity in [critical]');
        expect(result.response.markdown).toContain('src/index.ts');
        expect(result.suggestionsCount).toBe(1);
    });
});
