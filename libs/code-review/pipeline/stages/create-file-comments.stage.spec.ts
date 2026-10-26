import { Test, TestingModule } from '@nestjs/testing';
import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { CreateFileCommentsStage } from './create-file-comments.stage';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { SUGGESTION_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
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
        // after any earlier stage's produce(). A direct write to it (once
        // `pullRequest.heavy = …`, c886e369a) threw before
        // aggregateAndSaveDataStructure: comments were posted, but no
        // suggestion was persisted. baseContext() is frozen, so the guard is
        // the default, not this one case.
        await stage.execute(baseContext());

        expect(
            mockPullRequestService.aggregateAndSaveDataStructure,
        ).toHaveBeenCalledTimes(1);
        const savedPullRequest =
            mockPullRequestService.aggregateAndSaveDataStructure.mock
                .calls[0][0];
        expect(savedPullRequest.number).toBe(99);
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

    it('records the reviewed head as analyzed, not whichever commit sorts last (#2037)', async () => {
        // Rebased commits share one committer date, so a date-sorted list can
        // end on the oldest commit. Bitbucket's head sha is 12 characters.
        const head = 'abcdef123456' + '0'.repeat(28);
        const ctx = baseContext({
            pullRequest: { number: 99, head: { sha: 'abcdef123456' } },
            prAllCommits: [{ sha: head }, { sha: 'oldest' }],
        } as any);

        const result = await stage.execute(ctx);

        expect(result.lastAnalyzedCommit).toEqual({ sha: head });
    });

    it('falls back to the last listed commit when the head is not in the list', async () => {
        const ctx = baseContext({
            pullRequest: { number: 99, head: { sha: 'gone-by-force-push' } },
            prAllCommits: [{ sha: 'commit-1' }, { sha: 'commit-2' }],
        } as any);

        const result = await stage.execute(ctx);

        expect(result.lastAnalyzedCommit).toEqual({ sha: 'commit-2' });
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
});
