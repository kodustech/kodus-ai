import { Test, TestingModule } from '@nestjs/testing';
import { CreateFileCommentsStage } from './create-file-comments.stage';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { SUGGESTION_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { DRY_RUN_SERVICE_TOKEN } from '@libs/dryRun/domain/contracts/dryRun.service.contract';
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
    let mockDryRunService: any;

    const baseContext = (overrides: Partial<CodeReviewPipelineContext> = {}) =>
        ({
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
            dryRun: { enabled: false },
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
        mockDryRunService = {
            addFilesToDryRun: jest.fn().mockResolvedValue(undefined),
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
                    provide: DRY_RUN_SERVICE_TOKEN,
                    useValue: mockDryRunService,
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
            mockPullRequestService.aggregateAndSaveDataStructure.mock
                .calls[0];
        // Signature: (pullRequest, repository, enrichedFiles, prioritized,
        //            unused, platformType, organizationAndTeamData, commits)
        const enrichedFiles = callArgs[2];
        const orgAndTeam = callArgs[6];

        expect(enrichedFiles).toHaveLength(1);
        expect(enrichedFiles[0].filename).toBe('src/foo.ts');
        expect(orgAndTeam.organizationId).toBe('org-A');
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

    it('skips Mongo persistence and routes to dryRunService when dryRun is enabled', async () => {
        const ctx = baseContext({
            dryRun: { enabled: true, id: 'dry-1' },
        } as any);

        await stage.execute(ctx);

        expect(mockDryRunService.addFilesToDryRun).toHaveBeenCalledTimes(1);
        expect(
            mockPullRequestService.aggregateAndSaveDataStructure,
        ).not.toHaveBeenCalled();
    });
});
