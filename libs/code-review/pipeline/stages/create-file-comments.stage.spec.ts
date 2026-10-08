import { Test, TestingModule } from '@nestjs/testing';
import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { CreateFileCommentsStage } from './create-file-comments.stage';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { SUGGESTION_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Regression coverage for the silent data-loss bug where the stage took the
 * "no valid suggestions" branch and only persisted the PR if there were
 * discarded suggestions. PRs with nothing to comment on (validSuggestions=0
 * and discardedSuggestions=0) used to land in Mongo with files: [].
 *
 * The fix removed the `if (discardedSuggestions.length > 0)` gate so the
 * save runs whenever validSuggestions is empty, regardless of discarded.
 */
describe('CreateFileCommentsStage — empty-suggestions persistence', () => {
    let stage: CreateFileCommentsStage;
    let mockCommentManagerService: any;
    let mockPullRequestService: any;
    let mockSuggestionService: any;
    let mockPullRequestManagerService: any;

    // Frozen by DEFAULT: that is the shape production hands every stage after
    // the first produce(). See test/fixtures/frozen-pipeline-context.ts.
    const baseContext = (overrides: Partial<CodeReviewPipelineContext> = {}) =>
        frozenContext({
            organizationAndTeamData: {
                organizationId: 'org-A',
                teamId: 'team-1',
            },
            pullRequest: { number: 99 },
            repository: { id: 'repo-1', name: 'cal.com' },
            platformType: 'GITHUB',
            changedFiles: [
                {
                    filename: 'src/foo.ts',
                    additions: 1,
                    deletions: 0,
                    changes: 1,
                },
            ],
            validSuggestions: [],
            discardedSuggestions: [],
            prAllCommits: [{ sha: 'commit-1' }],
            fileMetadata: new Map(),
            ...overrides,
        }) as any as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockCommentManagerService = {};
        mockPullRequestService = {
            aggregateAndSaveDataStructure: jest.fn().mockResolvedValue(null),
        };
        mockSuggestionService = {
            resolveImplementedSuggestionsOnPlatform: jest
                .fn()
                .mockResolvedValue(undefined),
            verifyIfSuggestionsWereSent: jest.fn().mockResolvedValue([]),
            extractRepriorizedSuggestions: jest.fn().mockReturnValue({
                repriorizedSuggestions: [],
                filteredDiscardedSuggestions: [],
            }),
        };
        mockPullRequestManagerService = {
            getChangedFilesMetadata: jest.fn().mockResolvedValue([]),
        };

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
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: mockPullRequestManagerService,
                },
            ],
        }).compile();

        stage = module.get<CreateFileCommentsStage>(CreateFileCommentsStage);
    });

    it('persists changedFiles even when there are no valid AND no discarded suggestions', async () => {
        // The bug: this exact combination (both arrays empty) used to skip
        // the save call entirely and leave files: [] in the document.
        const ctx = baseContext({
            validSuggestions: [],
            discardedSuggestions: [],
        } as any);

        await stage.execute(ctx);

        expect(
            mockPullRequestService.aggregateAndSaveDataStructure,
        ).toHaveBeenCalledTimes(1);

        const callArgs =
            mockPullRequestService.aggregateAndSaveDataStructure.mock.calls[0];
        // Signature: (pullRequest, repository, enrichedFiles, prioritized,
        //            unused, platformType, organizationAndTeamData, commits)
        const enrichedFiles = callArgs[2];
        const orgAndTeam = callArgs[6];

        expect(enrichedFiles).toHaveLength(1);
        expect(enrichedFiles[0].filename).toBe('src/foo.ts');
        expect(orgAndTeam.organizationId).toBe('org-A');
    });

    it('persists when the context (incl. pullRequest) is Immer-frozen (regression)', async () => {
        // In production the pipeline context is Immer-frozen (auto-freeze)
        // after any earlier stage's produce(). The stage stamped the resolved
        // heavy flag via direct mutation — `pullRequest.heavy = …` — which
        // threw "Cannot assign to read only property 'heavy'" BEFORE
        // aggregateAndSaveDataStructure on every review: comments were
        // posted, but no suggestion was ever persisted (found live in QA,
        // broken env-wide since the heavy-mode rollout). Same failure class
        // as the context.heavy write fixed in agent-review.stage (#1522).
        // baseContext() is frozen now, so this reads like every other test —
        // which is the point: the guard is the default, not this one case.
        await stage.execute(baseContext({ heavy: true } as any));

        expect(
            mockPullRequestService.aggregateAndSaveDataStructure,
        ).toHaveBeenCalledTimes(1);
        const savedPullRequest =
            mockPullRequestService.aggregateAndSaveDataStructure.mock
                .calls[0][0];
        expect(savedPullRequest.number).toBe(99);
        expect(savedPullRequest.heavy).toBe(true);
    });

    it('still persists when validSuggestions=0 but discardedSuggestions has items (regression for the prior happy path)', async () => {
        const ctx = baseContext({
            validSuggestions: [],
            discardedSuggestions: [{ id: 'd-1' } as any],
        } as any);

        await stage.execute(ctx);

        expect(
            mockPullRequestService.aggregateAndSaveDataStructure,
        ).toHaveBeenCalledTimes(1);
    });

    it('aborts early (no save) when there are no commits', async () => {
        // The early-return on missing commits predates the fix and must
        // still hold — otherwise we would call aggregateAndSave with stale
        // commit context.
        const ctx = baseContext({ prAllCommits: [] } as any);

        await stage.execute(ctx);

        expect(
            mockPullRequestService.aggregateAndSaveDataStructure,
        ).not.toHaveBeenCalled();
    });
    it('records missing prompt delivery as partial while preserving frozen input', async () => {
        const error = new Error('reply failed');
        mockCommentManagerService.createLineComments = jest.fn(
            async (...args: unknown[]) => {
                (args[8] as (error: Error) => void)(error);
                return { commentResults: [], lastAnalyzedCommit: 'abc' };
            },
        );
        const ctx = baseContext({
            errors: [],
            codeReviewConfig: {},
            validSuggestions: [
                {
                    relevantFile: 'src/foo.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    suggestionContent: 'Guard null.',
                    severity: 'high',
                    label: 'bug',
                },
            ] as never,
        });
        const out = await stage.execute(ctx);
        expect(ctx.errors).toEqual([]);
        expect(out.errors).toEqual([
            expect.objectContaining({
                severity: 'partial',
                substage: 'bitbucket-prompt-reply',
                error,
            }),
        ]);
        expect(out.lastAnalyzedCommit).toBe('abc');
    });

    it('suppresses comments on files unchanged since an orphaned-base full re-run (#2037)', async () => {
        mockCommentManagerService.createLineComments = jest
            .fn()
            .mockResolvedValue({ commentResults: [], lastAnalyzedCommit: 'new-head' });
        mockPullRequestManagerService.getChangedFilesMetadata = jest
            .fn()
            .mockResolvedValue([
                { filename: 'src/changed.ts', additions: 2, deletions: 1, changes: 3 },
            ]);

        const ctx = baseContext({
            platformType: 'GITHUB',
            changedFiles: [
                { filename: 'src/changed.ts', additions: 2, deletions: 1, changes: 3 },
                { filename: 'src/unchanged.ts', additions: 2, deletions: 1, changes: 3 },
            ],
            validSuggestions: [
                {
                    relevantFile: 'src/changed.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    suggestionContent: 'Fix changed.',
                    severity: 'high',
                    label: 'bug',
                },
                {
                    relevantFile: 'src/unchanged.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    suggestionContent: 'Fix unchanged.',
                    severity: 'medium',
                    label: 'bug',
                },
            ] as never,
            pipelineMetadata: { forceFullRerun: true },
            orphanedBaseCommit: {
                previousSha: 'old-head',
                currentHeadSha: 'new-head',
                totalCommits: 2,
            },
        });

        await stage.execute(ctx);

        // The seeded diff shows only src/changed.ts changed since the previous
        // head, so only that suggestion is handed to the comment manager; the
        // unchanged-file one is suppressed before posting.
        expect(
            mockPullRequestManagerService.getChangedFilesMetadata,
        ).toHaveBeenCalledTimes(1);
        expect(
            mockPullRequestManagerService.getChangedFilesMetadata,
        ).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            'old-head',
        );

        const posted =
            mockCommentManagerService.createLineComments.mock.calls[0][3];
        expect((posted as Array<{ path: string }>).map((c) => c.path)).toEqual([
            'src/changed.ts',
        ]);
    });

    it('does not suppress without an orphaned base (normal incremental run)', async () => {
        mockCommentManagerService.createLineComments = jest
            .fn()
            .mockResolvedValue({ commentResults: [], lastAnalyzedCommit: 'new-head' });
        mockPullRequestManagerService.getChangedFilesMetadata = jest.fn();

        const ctx = baseContext({
            platformType: 'GITHUB',
            changedFiles: [
                { filename: 'src/unchanged.ts', additions: 1, deletions: 0, changes: 1 },
            ],
            validSuggestions: [
                {
                    relevantFile: 'src/unchanged.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    suggestionContent: 'Fix.',
                    severity: 'high',
                    label: 'bug',
                },
            ] as never,
            // No forceFullRerun, no orphanedBaseCommit: the guard must not run.
        });

        await stage.execute(ctx);

        expect(
            mockPullRequestManagerService.getChangedFilesMetadata,
        ).not.toHaveBeenCalled();
        const posted =
            mockCommentManagerService.createLineComments.mock.calls[0][3];
        expect((posted as Array<{ path: string }>).map((c) => c.path)).toEqual([
            'src/unchanged.ts',
        ]);
    });
});
