import { Test, TestingModule } from '@nestjs/testing';
import { CreateFileCommentsStage } from '@/code-review/pipeline/stages/create-file-comments.stage';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@/code-review/domain/contracts/CommentManagerService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { SUGGESTION_SERVICE_TOKEN } from '@/code-review/domain/contracts/SuggestionService.contract';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';
import { ClusteringType } from '@/core/infrastructure/config/types/general/codeReview.type';

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

describe('CreateFileCommentsStage', () => {
    let stage: CreateFileCommentsStage;

    const mockCommentManagerService = {
        createLineComments: jest.fn(),
    };

    const mockPullRequestService = {
        aggregateAndSaveDataStructure: jest.fn(),
    };

    const mockSuggestionService = {
        verifyIfSuggestionsWereSent: jest.fn(),
        resolveImplementedSuggestionsOnPlatform: jest.fn(),
        extractRepriorizedSuggestions: jest.fn(),
    };

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ) => ({
        organizationAndTeamData: {
            organizationId: 'org-123',
            teamId: 'team-456',
        } as any,
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
        },
        platformType: PlatformType.GITHUB,
        codeReviewConfig: {
            languageResultPrompt: 'en',
        } as any,
        validSuggestions: [],
        discardedSuggestions: [],
        changedFiles: [],
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
            ],
        }).compile();

        stage = module.get<CreateFileCommentsStage>(CreateFileCommentsStage);

        jest.resetAllMocks();
        mockCommentManagerService.createLineComments.mockResolvedValue({
            lastAnalyzedCommit: 'abc123',
            commentResults: [],
        });
        mockSuggestionService.verifyIfSuggestionsWereSent.mockResolvedValue([]);
        mockSuggestionService.extractRepriorizedSuggestions.mockImplementation(
            (_commentResults: any, discarded: any) => ({
                repriorizedSuggestions: [],
                filteredDiscardedSuggestions: discarded,
            }),
        );
    });

    const postedLineComments = () =>
        mockCommentManagerService.createLineComments.mock.calls[0][3];

    it.each([
        ['organizationAndTeamData', { organizationAndTeamData: undefined }],
        ['pullRequest', { pullRequest: undefined }],
        ['repository', { repository: undefined }],
    ])(
        'posts and persists nothing when %s is missing',
        async (_label, patch) => {
            const context = createBaseContext({
                validSuggestions: [
                    { id: 's1', relevantFile: 'test.ts', severity: 'high' },
                ],
                changedFiles: [{ filename: 'test.ts' } as any],
                prAllCommits: [{ sha: 'abc123' }] as any,
                ...(patch as any),
            });

            await (stage as any).executeStage(context);

            expect(
                mockCommentManagerService.createLineComments,
            ).not.toHaveBeenCalled();
            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).not.toHaveBeenCalled();
        },
    );

    describe('processing suggestions', () => {
        it('stores the posted comments and the commit they anchored on', async () => {
            mockCommentManagerService.createLineComments.mockResolvedValue({
                lastAnalyzedCommit: 'def456',
                commentResults: [
                    { comment: { id: 1 }, deliveryStatus: 'sent' },
                ],
            });

            const context = createBaseContext({
                validSuggestions: [
                    {
                        id: 's1',
                        relevantFile: 'test.ts',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 12,
                    },
                ],
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            // RequestChangesOrApproveStage reads lineComments to decide
            // whether the PR is clean enough to approve.
            expect(result.lineComments).toEqual([
                { comment: { id: 1 }, deliveryStatus: 'sent' },
            ]);
            expect(result.lastAnalyzedCommit).toBe('def456');
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

            const context = createBaseContext({
                validSuggestions,
                changedFiles: [
                    { filename: 'a.ts' } as any,
                    { filename: 'm.ts' } as any,
                    { filename: 'z.ts' } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const observedOrder = postedLineComments().map(
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

            const context = createBaseContext({
                validSuggestions,
                changedFiles: [
                    { filename: 'a.ts' } as any,
                    { filename: 'b.ts' } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const observedOrder = postedLineComments().map(
                (c: any) => `${c.path}:${c.suggestion.id}`,
            );

            // a.ts before b.ts; within a.ts the known severity wins over
            // the unknown/missing one.
            expect(observedOrder).toEqual(['a.ts:3', 'a.ts:2', 'b.ts:1']);
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

            const context = createBaseContext({
                validSuggestions: suggestions,
                changedFiles: [
                    { filename: 'kept.ts', status: 'modified' } as any,
                    { filename: 'deleted.ts', status: 'removed' } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const lineComments = postedLineComments();
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

            const context = createBaseContext({
                validSuggestions: suggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            await (stage as any).executeStage(context);

            const lineComments = postedLineComments();
            expect(lineComments).toHaveLength(1);
            expect(lineComments[0].suggestion.id).toBe('s1');
        });
    });

    describe('saving discarded suggestions to database', () => {
        it('persists every discarded suggestion, whatever the reason, when none is valid', async () => {
            const discardedSuggestions = [
                { id: 's1', relevantFile: 'test.ts', priorityStatus: 'discarded-by-code-diff' },
                { id: 's2', relevantFile: 'test.ts', priorityStatus: 'discarded-by-severity' },
                { id: 's3', relevantFile: 'test.ts', priorityStatus: 'discarded-by-safeguard' },
                { id: 's4', relevantFile: 'test.ts', priorityStatus: 'discarded-by-kody-fine-tuning' },
            ] as any[];

            const context = createBaseContext({
                validSuggestions: [],
                discardedSuggestions,
                changedFiles: [{ filename: 'test.ts' } as any],
                prAllCommits: [{ sha: 'abc123' }] as any,
            });

            await (stage as any).executeStage(context);

            expect(
                mockPullRequestService.aggregateAndSaveDataStructure,
            ).toHaveBeenCalledTimes(1);
            // 5th argument: the unused (discarded) suggestions.
            const unusedSuggestions =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0][4];
            expect(unusedSuggestions.map((s: any) => s.priorityStatus)).toEqual([
                'discarded-by-code-diff',
                'discarded-by-severity',
                'discarded-by-safeguard',
                'discarded-by-kody-fine-tuning',
            ]);
        });
    });

    describe('error handling', () => {
        it('should handle errors in line comments creation gracefully', async () => {
            mockCommentManagerService.createLineComments.mockRejectedValue(
                new Error('API error'),
            );

            const context = createBaseContext({
                validSuggestions: [
                    { id: 's1', relevantFile: 'test.ts', severity: 'high' },
                ],
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            // Should return context with empty comments, not crash
            expect(result.lineComments).toHaveLength(0);
        });
    });

    describe('file metadata enrichment', () => {
        it('should enrich changed files with metadata', async () => {
            const fileMetadata = new Map([
                [
                    'test.ts',
                    { reviewMode: 'heavy', codeReviewModelUsed: 'gpt-4' },
                ],
            ]);

            const context = createBaseContext({
                validSuggestions: [
                    { id: 's1', relevantFile: 'test.ts', severity: 'high' },
                ],
                changedFiles: [{ filename: 'test.ts' } as any],
                fileMetadata,
            });

            await (stage as any).executeStage(context);

            const enrichedFiles =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0][2];
            expect(enrichedFiles[0].reviewMode).toBe('heavy');
            expect(enrichedFiles[0].codeReviewModelUsed).toBe('gpt-4');
        });
    });

    // Docblock hunk with a single inserted line: added line 1032, context
    // lines 1030/1031/1033/1034/1035 (mirrors the field report).
    const DOCBLOCK_PATCH = `@@ -1030,5 +1030,6 @@ class InvoiceRenderer
      * Render the invoice header.
      *
+     * @param array $meta additional metadata
      * @param int $id
      * @return void
      */`;

    describe('GitLab added-line anchoring gate', () => {
        it('keeps added-line comments, snaps context-in-span onto the added line, discards context-only', async () => {
            const validSuggestions = [
                // anchor already on the added line → kept as-is.
                { id: 'added', relevantFile: 'Invoice.php', severity: 'high', relevantLinesStart: 1032, relevantLinesEnd: 1032 },
                // single context line, added line outside its span → discarded.
                { id: 'context', relevantFile: 'Invoice.php', severity: 'high', relevantLinesStart: 1035, relevantLinesEnd: 1035 },
                // multi-line span [1030,1034] covering the added line → snapped to 1032.
                { id: 'snap', relevantFile: 'Invoice.php', severity: 'high', relevantLinesStart: 1030, relevantLinesEnd: 1034 },
            ] as any[];

            const context = createBaseContext({
                platformType: PlatformType.GITLAB,
                validSuggestions,
                changedFiles: [
                    { filename: 'Invoice.php', status: 'modified', patch: DOCBLOCK_PATCH } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const posted = postedLineComments();
            expect(posted.map((c: any) => c.suggestion.id)).toEqual([
                'added',
                'snap',
            ]);

            const added = posted.find((c: any) => c.suggestion.id === 'added');
            expect(added.line).toBe(1032);
            expect(added.start_line).toBeUndefined();

            const snap = posted.find((c: any) => c.suggestion.id === 'snap');
            expect(snap.line).toBe(1032);
            expect(snap.start_line).toBeUndefined();

            // The context-only comment reaches Mongo as discarded-by-code-diff.
            const unusedSuggestions =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0][4];
            const discarded = unusedSuggestions.find(
                (s: any) => s.id === 'context',
            );
            expect(discarded.priorityStatus).toBe('discarded-by-code-diff');
        });

        it('does not double-persist a discarded suggestion — it is removed from the prioritized list (no phantom failed)', async () => {
            const validSuggestions = [
                // kept: anchor on the added line.
                { id: 'added', relevantFile: 'Invoice.php', severity: 'high', relevantLinesStart: 1032, relevantLinesEnd: 1032 },
                // discarded: single context line, no added line in span.
                { id: 'context', relevantFile: 'Invoice.php', severity: 'high', relevantLinesStart: 1035, relevantLinesEnd: 1035 },
            ] as any[];

            // Passthrough so we can inspect exactly which suggestions reach
            // persistence as prioritized (the ones that would get a delivery status).
            mockSuggestionService.verifyIfSuggestionsWereSent.mockImplementation(
                (_o: any, _pr: any, prioritized: any) => prioritized,
            );

            const context = createBaseContext({
                platformType: PlatformType.GITLAB,
                validSuggestions,
                changedFiles: [
                    { filename: 'Invoice.php', status: 'modified', patch: DOCBLOCK_PATCH } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const saveArgs =
                mockPullRequestService.aggregateAndSaveDataStructure.mock
                    .calls[0];
            const prioritized = saveArgs[3];
            const unused = saveArgs[4];

            // The discarded suggestion must NOT be persisted as prioritized
            // (that path would stamp it FAILED — the duplicate bug).
            expect(
                prioritized.some((s: any) => s.id === 'context'),
            ).toBe(false);
            // The kept one stays prioritized.
            expect(prioritized.some((s: any) => s.id === 'added')).toBe(true);

            // It appears exactly once overall, only as discarded-by-code-diff.
            const contextInUnused = unused.filter(
                (s: any) => s.id === 'context',
            );
            expect(contextInUnused).toHaveLength(1);
            expect(contextInUnused[0].priorityStatus).toBe(
                'discarded-by-code-diff',
            );
        });

        it('leaves GitHub untouched — a context-line comment is still posted as-is', async () => {
            const validSuggestions = [
                { id: 'context', relevantFile: 'Invoice.php', severity: 'high', relevantLinesStart: 1035, relevantLinesEnd: 1035 },
            ] as any[];

            const context = createBaseContext({
                platformType: PlatformType.GITHUB,
                validSuggestions,
                changedFiles: [
                    { filename: 'Invoice.php', status: 'modified', patch: DOCBLOCK_PATCH } as any,
                ],
            });

            await (stage as any).executeStage(context);

            const posted = postedLineComments();
            expect(posted).toHaveLength(1);
            expect(posted[0].suggestion.id).toBe('context');
            expect(posted[0].line).toBe(1035);
        });
    });
});
