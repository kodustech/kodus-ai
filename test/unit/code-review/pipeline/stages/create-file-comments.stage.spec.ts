import { Test, TestingModule } from '@nestjs/testing';
import { CreateFileCommentsStage } from '@/code-review/pipeline/stages/create-file-comments.stage';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@/code-review/domain/contracts/CommentManagerService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { SUGGESTION_SERVICE_TOKEN } from '@/code-review/domain/contracts/SuggestionService.contract';
import { DRY_RUN_SERVICE_TOKEN } from '@/dryRun/domain/contracts/dryRun.service.contract';
import { CodeManagementService } from '@/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';
import { DeliveryStatus } from '@/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ClusteringType } from '@/core/infrastructure/config/types/general/codeReview.type';

// Mock logger to silence logs during tests
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('CreateFileCommentsStage', () => {
    let stage: CreateFileCommentsStage;

    const mockCommentManagerService = {
        createLineComments: jest.fn(),
    };

    const mockPullRequestService = {
        aggregateAndSaveDataStructure: jest.fn(),
        findByNumberAndRepositoryName: jest.fn(),
    };

    const mockSuggestionService = {
        sortAndPrioritizeSuggestions: jest.fn(),
        verifyIfSuggestionsWereSent: jest.fn(),
        resolveImplementedSuggestionsOnPlatform: jest.fn(),
        extractRepriorizedSuggestions: jest.fn(),
    };

    const mockDryRunService = {
        addFilesToDryRun: jest.fn(),
    };

    const mockCodeManagementService = {
        getCommitsForPullRequestForCodeReview: jest.fn(),
        getPullRequestReviewThreads: jest.fn(),
        getPullRequestReviewComments: jest.fn(),
        markReviewCommentAsResolved: jest.fn(),
    };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ) => ({
        dryRun: { enabled: false },
        organizationAndTeamData: mockOrganizationAndTeamData as any,
        repository: {
            id: 'repo-1',
            name: 'test-repo',
            language: 'typescript',
        } as any,
        branch: 'main',
        pullRequest: {
            number: 123,
            title: 'Test PR',
            base: { repo: { fullName: 'org/repo' }, ref: 'main' },
            repository: {} as any,
            isDraft: false,
            stats: {
                total_additions: 10,
                total_deletions: 5,
                total_files: 2,
                total_lines_changed: 15,
            },
        },
        teamAutomationId: 'team-auto-1',
        origin: 'github',
        action: 'opened',
        platformType: PlatformType.GITHUB,
        codeReviewConfig: {
            languageResultPrompt: 'en',
        } as any,
        validSuggestions: [],
        discardedSuggestions: [],
        changedFiles: [],
        preparedFileContexts: [],
        correlationId: 'test-correlation-id',
        ...overrides,
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CreateFileCommentsStage,
                {
                    provide: COMMENT_MANAGER_SERVICE_TOKEN,
                    useValue: mockCommentManagerService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestService,
                },
                {
                    provide: SUGGESTION_SERVICE_TOKEN,
                    useValue: mockSuggestionService,
                },
                { provide: DRY_RUN_SERVICE_TOKEN, useValue: mockDryRunService },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        stage = module.get<CreateFileCommentsStage>(CreateFileCommentsStage);
        jest.clearAllMocks();
    });

    describe('stage name', () => {
        it('should have correct stage name', () => {
            expect(stage.stageName).toBe('CreateFileCommentsStage');
        });
    });

    describe('context validation', () => {
        it('should return context unchanged when organizationAndTeamData is missing', async () => {
            const context = createBaseContext({
                organizationAndTeamData: undefined as any,
            });

            const result = await (stage as any).executeStage(context);

            expect(result).toBeDefined();
            expect(
                mockCommentManagerService.createLineComments,
            ).not.toHaveBeenCalled();
        });

        it('should return context unchanged when pullRequest is missing', async () => {
            const context = createBaseContext({
                pullRequest: undefined as any,
            });

            const result = await (stage as any).executeStage(context);

            expect(result).toBeDefined();
            expect(
                mockCommentManagerService.createLineComments,
            ).not.toHaveBeenCalled();
        });

        it('should return context unchanged when repository is missing', async () => {
            const context = createBaseContext({
                repository: undefined as any,
            });

            const result = await (stage as any).executeStage(context);

            expect(result).toBeDefined();
            expect(
                mockCommentManagerService.createLineComments,
            ).not.toHaveBeenCalled();
        });
    });

    describe('processing suggestions', () => {
        it('should process valid suggestions and create comments', async () => {
            const validSuggestions = [
                {
                    id: 's1',
                    relevantFile: 'test.ts',
                    severity: 'high',
                    suggestionContent: 'Use const instead of let',
                    improvedCode: 'const x = 1;',
                    relevantLinesStart: 10,
                    relevantLinesEnd: 12,
                },
            ];

            mockSuggestionService.sortAndPrioritizeSuggestions.mockResolvedValue(
                {
                    sortedPrioritizedSuggestions: validSuggestions,
                    allDiscardedSuggestions: [],
                },
            );

            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [
                    { comment: { id: 1 }, deliveryStatus: DeliveryStatus.SENT },
                ],
            });

            mockSuggestionService.verifyIfSuggestionsWereSent.mockResolvedValue(
                validSuggestions,
            );
            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: [],
                },
            );
            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                validSuggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            // sortAndPrioritizeSuggestions is no longer called — v2 filtering removed
            expect(
                mockCommentManagerService.createLineComments,
            ).toHaveBeenCalled();
            expect(result.lineComments).toHaveLength(1);
            expect(result.lastAnalyzedCommit).toBe('abc123');
        });

        it('groups comments for the same file together, critical → low within a file, files alphabetical', async () => {
            // Interleaved on purpose: mixing files and severities.
            const validSuggestions = [
                { id: '1', relevantFile: 'z.ts', severity: 'low', relevantLinesStart: 5, relevantLinesEnd: 5 },
                { id: '2', relevantFile: 'a.ts', severity: 'medium', relevantLinesStart: 10, relevantLinesEnd: 10 },
                { id: '3', relevantFile: 'z.ts', severity: 'critical', relevantLinesStart: 20, relevantLinesEnd: 20 },
                { id: '4', relevantFile: 'a.ts', severity: 'critical', relevantLinesStart: 1, relevantLinesEnd: 1 },
                { id: '5', relevantFile: 'm.ts', severity: 'high', relevantLinesStart: 30, relevantLinesEnd: 30 },
                { id: '6', relevantFile: 'a.ts', severity: 'low', relevantLinesStart: 50, relevantLinesEnd: 50 },
            ] as any[];

            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [],
            });
            mockSuggestionService.verifyIfSuggestionsWereSent.mockResolvedValue([]);
            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue({
                repriorizedSuggestions: [],
                filteredDiscardedSuggestions: [],
            });
            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );
            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                { number: 123, files: [] },
            );

            const context = createBaseContext({
                validSuggestions,
                changedFiles: [
                    { filename: 'a.ts' } as any,
                    { filename: 'm.ts' } as any,
                    { filename: 'z.ts' } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const passedLineComments =
                mockCommentManagerService.createLineComments.mock.calls[0][3];
            const observedOrder = passedLineComments.map(
                (c: any) => `${c.path}:${c.suggestion.id}/${c.suggestion.severity}`,
            );

            expect(observedOrder).toEqual([
                'a.ts:4/critical', // same file grouped, critical first
                'a.ts:2/medium',
                'a.ts:6/low',
                'm.ts:5/high',     // files alphabetical after a.ts
                'z.ts:3/critical', // z.ts last, critical before low
                'z.ts:1/low',
            ]);
        });

        it('falls back to file-alphabetical order when severities are missing or unknown', async () => {
            const validSuggestions = [
                { id: '1', relevantFile: 'b.ts', severity: 'weird' as any, relevantLinesStart: 1, relevantLinesEnd: 1 },
                { id: '2', relevantFile: 'a.ts', severity: undefined as any, relevantLinesStart: 1, relevantLinesEnd: 1 },
                { id: '3', relevantFile: 'a.ts', severity: 'high', relevantLinesStart: 2, relevantLinesEnd: 2 },
            ] as any[];

            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [],
            });
            mockSuggestionService.verifyIfSuggestionsWereSent.mockResolvedValue([]);
            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue({
                repriorizedSuggestions: [],
                filteredDiscardedSuggestions: [],
            });
            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );
            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                { number: 123, files: [] },
            );

            const context = createBaseContext({
                validSuggestions,
                changedFiles: [
                    { filename: 'a.ts' } as any,
                    { filename: 'b.ts' } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const passedLineComments =
                mockCommentManagerService.createLineComments.mock.calls[0][3];
            const observedOrder = passedLineComments.map(
                (c: any) => `${c.path}:${c.suggestion.id}`,
            );

            // a.ts before b.ts; within a.ts the known severity wins over
            // the unknown/missing one.
            expect(observedOrder).toEqual(['a.ts:3', 'a.ts:2', 'b.ts:1']);
        });

        it('should return empty line comments when no valid suggestions', async () => {
            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                validSuggestions: [],
                changedFiles: [{ filename: 'test.ts' } as any],
                // prAllCommits é necessário para determinar lastAnalyzedCommit
                prAllCommits: [{ sha: 'abc123' }] as any,
            });

            const result = await (stage as any).executeStage(context);

            expect(result.lineComments).toHaveLength(0);
            expect(
                mockSuggestionService.sortAndPrioritizeSuggestions,
            ).not.toHaveBeenCalled();
        });

        // Bug A1 regression: a suggestion pointing at a file that was
        // DELETED in the PR should never produce a line comment. Posting a
        // comment on a removed file breaks the git provider APIs (the file
        // no longer has a line to attach to) and has been observed
        // producing confusing false-positive reviews.
        it('filters out suggestions targeting removed files', async () => {
            const suggestions = [
                {
                    id: 's-kept',
                    relevantFile: 'kept.ts',
                    clusteringInformation: { type: ClusteringType.PARENT },
                },
                {
                    id: 's-removed',
                    relevantFile: 'deleted.ts',
                    clusteringInformation: { type: ClusteringType.PARENT },
                },
            ];

            mockSuggestionService.sortAndPrioritizeSuggestions.mockResolvedValue(
                {
                    sortedPrioritizedSuggestions: suggestions,
                    allDiscardedSuggestions: [],
                },
            );
            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [],
            });
            mockSuggestionService.verifyIfSuggestionsWereSent.mockResolvedValue(
                [],
            );
            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: [],
                },
            );
            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );
            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                { number: 123, files: [] },
            );

            const context = createBaseContext({
                validSuggestions: suggestions,
                changedFiles: [
                    { filename: 'kept.ts', status: 'modified' } as any,
                    { filename: 'deleted.ts', status: 'removed' } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const callArgs =
                mockCommentManagerService.createLineComments.mock.calls[0];
            const lineComments = callArgs[3];
            expect(lineComments).toHaveLength(1);
            expect(lineComments[0].suggestion.id).toBe('s-kept');
        });

        it('should filter out RELATED suggestions from line comments', async () => {
            const suggestions = [
                {
                    id: 's1',
                    relevantFile: 'test.ts',
                    clusteringInformation: { type: ClusteringType.PARENT },
                },
                {
                    id: 's2',
                    relevantFile: 'test.ts',
                    clusteringInformation: { type: ClusteringType.RELATED },
                },
            ];

            mockSuggestionService.sortAndPrioritizeSuggestions.mockResolvedValue(
                {
                    sortedPrioritizedSuggestions: suggestions,
                    allDiscardedSuggestions: [],
                },
            );

            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [],
            });

            mockSuggestionService.verifyIfSuggestionsWereSent.mockResolvedValue(
                [],
            );
            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: [],
                },
            );
            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                validSuggestions: suggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            await (stage as any).executeStage(context);

            // Check that the line comments passed to createLineComments filtered out RELATED
            const callArgs =
                mockCommentManagerService.createLineComments.mock.calls[0];
            const lineComments = callArgs[3]; // 4th argument
            expect(lineComments).toHaveLength(1);
            expect(lineComments[0].suggestion.id).toBe('s1');
        });
    });

    describe('dry run mode', () => {
        it('should add files to dry run when enabled', async () => {
            const validSuggestions = [
                { id: 's1', relevantFile: 'test.ts', severity: 'high' },
            ];

            mockSuggestionService.sortAndPrioritizeSuggestions.mockResolvedValue(
                {
                    sortedPrioritizedSuggestions: validSuggestions,
                    allDiscardedSuggestions: [],
                },
            );

            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [],
            });

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                dryRun: { enabled: true, id: 'dry-run-1' },
                validSuggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            await (stage as any).executeStage(context);

            expect(mockDryRunService.addFilesToDryRun).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'dry-run-1',
                }),
            );
        });

        it('should not save to database when dry run is enabled', async () => {
            const validSuggestions = [
                { id: 's1', relevantFile: 'test.ts', severity: 'high' },
            ];

            mockSuggestionService.sortAndPrioritizeSuggestions.mockResolvedValue(
                {
                    sortedPrioritizedSuggestions: validSuggestions,
                    allDiscardedSuggestions: [],
                },
            );

            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [],
            });

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                dryRun: { enabled: true, id: 'dry-run-1' },
                validSuggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            await (stage as any).executeStage(context);

            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('should handle errors in line comments creation gracefully', async () => {
            const validSuggestions = [
                { id: 's1', relevantFile: 'test.ts', severity: 'high' },
            ];

            mockSuggestionService.sortAndPrioritizeSuggestions.mockResolvedValue(
                {
                    sortedPrioritizedSuggestions: validSuggestions,
                    allDiscardedSuggestions: [],
                },
            );

            mockCommentManagerService.createLineComments.mockRejectedValue(
                new Error('API error'),
            );

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                validSuggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            // Should return context with empty comments, not crash
            expect(result.lineComments).toHaveLength(0);
        });

        it('should handle error in finalizeReviewProcessing gracefully', async () => {
            const validSuggestions = [
                { id: 's1', relevantFile: 'test.ts', severity: 'high' },
            ];

            mockSuggestionService.sortAndPrioritizeSuggestions.mockRejectedValue(
                new Error('Prioritization error'),
            );

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                validSuggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            // Should handle error gracefully
            expect(result.lineComments).toHaveLength(0);
        });
    });

    describe('resolving implemented suggestions', () => {
        it('should not resolve comments when dry run is enabled', async () => {
            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            const context = createBaseContext({
                dryRun: { enabled: true, id: 'dry-run-1' },
                validSuggestions: [],
            });

            await (stage as any).executeStage(context);

            expect(
                mockCodeManagementService.markReviewCommentAsResolved,
            ).not.toHaveBeenCalled();
        });

        it('should resolve comments for implemented suggestions on GitHub', async () => {
            const prEntity = {
                number: 123,
                files: [
                    {
                        suggestions: [
                            {
                                comment: { id: 100 },
                                implementationStatus: 'FULLY_IMPLEMENTED',
                                deliveryStatus: DeliveryStatus.SENT,
                            },
                        ],
                    },
                ],
            };

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                prEntity,
            );

            mockCodeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [{ id: 1, fullDatabaseId: '100', threadId: 'thread-1' }],
            );

            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            const context = createBaseContext({
                validSuggestions: [],
                platformType: PlatformType.GITHUB,
            });

            await (stage as any).executeStage(context);

            // Check that resolve was attempted
            expect(
                mockSuggestionService.resolveImplementedSuggestionsOnPlatform,
            ).toHaveBeenCalled();
        });
    });

    describe('file metadata enrichment', () => {
        it('should enrich changed files with metadata', async () => {
            const validSuggestions = [
                { id: 's1', relevantFile: 'test.ts', severity: 'high' },
            ];

            const changedFiles = [{ filename: 'test.ts' } as any];

            const fileMetadata = new Map([
                [
                    'test.ts',
                    { reviewMode: 'heavy', codeReviewModelUsed: 'gpt-4' },
                ],
            ]);

            mockSuggestionService.sortAndPrioritizeSuggestions.mockResolvedValue(
                {
                    sortedPrioritizedSuggestions: validSuggestions,
                    allDiscardedSuggestions: [],
                },
            );

            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'abc123',
                commentResults: [],
            });

            mockSuggestionService.verifyIfSuggestionsWereSent.mockResolvedValue(
                validSuggestions,
            );
            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: [],
                },
            );
            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                {
                    number: 123,
                    files: [],
                },
            );

            const context = createBaseContext({
                validSuggestions,
                changedFiles,
                fileMetadata,
            });

            await (stage as any).executeStage(context);

            // Verify aggregateAndSaveDataStructure was called with enriched files
            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).toHaveBeenCalled();
            const callArgs =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0];
            const enrichedFiles = callArgs[2]; // 3rd argument
            expect(enrichedFiles[0].reviewMode).toBe('heavy');
            expect(enrichedFiles[0].codeReviewModelUsed).toBe('gpt-4');
        });
    });

    describe('saving discarded suggestions to database', () => {
        it('should save all discarded suggestions to database when all suggestions are discarded by code-diff', async () => {
            const discardedSuggestions = [
                {
                    id: 's1',
                    relevantFile: 'test.ts',
                    severity: 'high',
                    suggestionContent: 'Use const instead of let',
                    priorityStatus: 'discarded-by-code-diff',
                },
                {
                    id: 's2',
                    relevantFile: 'test.ts',
                    severity: 'medium',
                    suggestionContent: 'Add type annotation',
                    priorityStatus: 'discarded-by-code-diff',
                },
            ] as any[];

            const changedFiles = [{ filename: 'test.ts' } as any];

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                null, // New PR, so no existing PR
            );

            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: discardedSuggestions,
                },
            );

            const context = createBaseContext({
                validSuggestions: [], // No valid suggestions
                discardedSuggestions, // Only discarded suggestions
                changedFiles,
                prAllCommits: [{ sha: 'abc123' }] as any,
            });

            await (stage as any).executeStage(context);

            // CRITICAL: aggregateAndSaveDataStructure MUST be called even when all suggestions are discarded
            // This is the bug - it won't be called because of early return at line 113-137
            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).toHaveBeenCalled();

            const callArgs =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0];
            const unusedSuggestions = callArgs[4]; // 5th argument - unusedSuggestions
            expect(unusedSuggestions).toHaveLength(2);
            expect(unusedSuggestions[0].priorityStatus).toBe(
                'discarded-by-code-diff',
            );
            expect(unusedSuggestions[1].priorityStatus).toBe(
                'discarded-by-code-diff',
            );
        });

        it('should save all discarded suggestions to database when all suggestions are discarded by severity', async () => {
            const discardedSuggestions = [
                {
                    id: 's1',
                    relevantFile: 'test.ts',
                    severity: 'low',
                    suggestionContent: 'Minor style improvement',
                    priorityStatus: 'discarded-by-severity',
                },
                {
                    id: 's2',
                    relevantFile: 'test.ts',
                    severity: 'info',
                    suggestionContent: 'Consider refactoring',
                    priorityStatus: 'discarded-by-severity',
                },
            ] as any[];

            const changedFiles = [{ filename: 'test.ts' } as any];

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                null,
            );

            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: discardedSuggestions,
                },
            );

            const context = createBaseContext({
                validSuggestions: [],
                discardedSuggestions,
                changedFiles,
                prAllCommits: [{ sha: 'abc123' }] as any,
            });

            await (stage as any).executeStage(context);

            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).toHaveBeenCalled();

            const callArgs =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0];
            const unusedSuggestions = callArgs[4];
            expect(unusedSuggestions).toHaveLength(2);
            expect(
                unusedSuggestions.every(
                    (s) => s.priorityStatus === 'discarded-by-severity',
                ),
            ).toBe(true);
        });

        it('should save all discarded suggestions to database when all suggestions are discarded by safeguard', async () => {
            const discardedSuggestions = [
                {
                    id: 's1',
                    relevantFile: 'test.ts',
                    severity: 'high',
                    suggestionContent: 'Remove this code',
                    priorityStatus: 'discarded-by-safeguard',
                },
            ] as any[];

            const changedFiles = [{ filename: 'test.ts' } as any];

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                null,
            );

            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: discardedSuggestions,
                },
            );

            const context = createBaseContext({
                validSuggestions: [],
                discardedSuggestions,
                changedFiles,
                prAllCommits: [{ sha: 'abc123' }] as any,
            });

            await (stage as any).executeStage(context);

            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).toHaveBeenCalled();

            const callArgs =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0];
            const unusedSuggestions = callArgs[4];
            expect(unusedSuggestions).toHaveLength(1);
            expect(unusedSuggestions[0].priorityStatus).toBe(
                'discarded-by-safeguard',
            );
        });

        it('should save all discarded suggestions to database when all suggestions are discarded by kody-fine-tuning', async () => {
            const discardedSuggestions = [
                {
                    id: 's1',
                    relevantFile: 'test.ts',
                    severity: 'medium',
                    suggestionContent: 'Update this pattern',
                    priorityStatus: 'discarded-by-kody-fine-tuning',
                },
                {
                    id: 's2',
                    relevantFile: 'test.ts',
                    severity: 'high',
                    suggestionContent: 'Fix this issue',
                    priorityStatus: 'discarded-by-kody-fine-tuning',
                },
            ] as any[];

            const changedFiles = [{ filename: 'test.ts' } as any];

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                null,
            );

            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: discardedSuggestions,
                },
            );

            const context = createBaseContext({
                validSuggestions: [],
                discardedSuggestions,
                changedFiles,
                prAllCommits: [{ sha: 'abc123' }] as any,
            });

            await (stage as any).executeStage(context);

            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).toHaveBeenCalled();

            const callArgs =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0];
            const unusedSuggestions = callArgs[4];
            expect(unusedSuggestions).toHaveLength(2);
            expect(
                unusedSuggestions.every(
                    (s) => s.priorityStatus === 'discarded-by-kody-fine-tuning',
                ),
            ).toBe(true);
        });

        it('should save mixed discarded suggestions to database when all are discarded by different reasons', async () => {
            const discardedSuggestions = [
                {
                    id: 's1',
                    relevantFile: 'test.ts',
                    severity: 'high',
                    suggestionContent: 'Fix 1',
                    priorityStatus: 'discarded-by-code-diff',
                },
                {
                    id: 's2',
                    relevantFile: 'test.ts',
                    severity: 'low',
                    suggestionContent: 'Fix 2',
                    priorityStatus: 'discarded-by-severity',
                },
                {
                    id: 's3',
                    relevantFile: 'test.ts',
                    severity: 'medium',
                    suggestionContent: 'Fix 3',
                    priorityStatus: 'discarded-by-safeguard',
                },
                {
                    id: 's4',
                    relevantFile: 'test.ts',
                    severity: 'high',
                    suggestionContent: 'Fix 4',
                    priorityStatus: 'discarded-by-kody-fine-tuning',
                },
            ] as any[];

            const changedFiles = [{ filename: 'test.ts' } as any];

            mockPullRequestService.findByNumberAndRepositoryName.mockResolvedValue(
                null,
            );

            mockCodeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
                [{ sha: 'abc123' }],
            );

            mockSuggestionService.extractRepriorizedSuggestions.mockReturnValue(
                {
                    repriorizedSuggestions: [],
                    filteredDiscardedSuggestions: discardedSuggestions,
                },
            );

            const context = createBaseContext({
                validSuggestions: [],
                discardedSuggestions,
                changedFiles,
                prAllCommits: [{ sha: 'abc123' }] as any,
            });

            await (stage as any).executeStage(context);

            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).toHaveBeenCalled();

            const callArgs =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0];
            const unusedSuggestions = callArgs[4];
            expect(unusedSuggestions).toHaveLength(4);
            expect(unusedSuggestions[0].priorityStatus).toBe(
                'discarded-by-code-diff',
            );
            expect(unusedSuggestions[1].priorityStatus).toBe(
                'discarded-by-severity',
            );
            expect(unusedSuggestions[2].priorityStatus).toBe(
                'discarded-by-safeguard',
            );
            expect(unusedSuggestions[3].priorityStatus).toBe(
                'discarded-by-kody-fine-tuning',
            );
        });
    });
});
