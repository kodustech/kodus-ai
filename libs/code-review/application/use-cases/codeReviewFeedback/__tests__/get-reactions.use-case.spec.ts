import { GetReactionsUseCase } from '../get-reactions.use-case';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import {
    createSampleOrganizationAndTeamData,
    createSamplePullRequestWithSuggestions,
    createSampleComment,
    createSampleReactionResult,
} from './fixtures';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

describe('GetReactionsUseCase', () => {
    let useCase: GetReactionsUseCase;
    let codeManagementService: {
        getPullRequestReviewComment: jest.Mock;
        countReactions: jest.Mock;
    };
    let pullRequestService: {
        findPullRequestsWithDeliveredSuggestions: jest.Mock;
    };

    const orgAndTeam = createSampleOrganizationAndTeamData();

    beforeEach(() => {
        codeManagementService = {
            getPullRequestReviewComment: jest.fn().mockResolvedValue([]),
            countReactions: jest.fn().mockResolvedValue([]),
        };
        pullRequestService = {
            findPullRequestsWithDeliveredSuggestions: jest
                .fn()
                .mockResolvedValue([]),
        };

        useCase = new GetReactionsUseCase(
            codeManagementService as any,
            pullRequestService as any,
        );
    });

    it('should return [] when automationExecutionsPRs is empty', async () => {
        const result = await useCase.execute(orgAndTeam, []);
        expect(result).toEqual([]);
        expect(
            pullRequestService.findPullRequestsWithDeliveredSuggestions,
        ).not.toHaveBeenCalled();
    });

    it('should return [] when no pull requests found', async () => {
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [],
        );

        const result = await useCase.execute(orgAndTeam, [1, 2]);

        expect(
            pullRequestService.findPullRequestsWithDeliveredSuggestions,
        ).toHaveBeenCalledWith(
            orgAndTeam.organizationId,
            [1, 2],
            [PullRequestState.MERGED, PullRequestState.CLOSED],
        );
        expect(result).toEqual([]);
    });

    it('should return [] when PR has no suggestions', async () => {
        const pr = createSamplePullRequestWithSuggestions({
            suggestions: [],
        });
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr],
        );

        const result = await useCase.execute(orgAndTeam, [42]);

        expect(
            codeManagementService.getPullRequestReviewComment,
        ).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('should fetch comments and reactions for PRs with suggestions', async () => {
        const pr = createSamplePullRequestWithSuggestions();
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr],
        );

        const comment = createSampleComment({ id: 100 });
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            comment,
        ]);

        const reaction = createSampleReactionResult({
            comment: { id: 100, pull_request_review_id: 'pr-review-200' },
        });
        codeManagementService.countReactions.mockResolvedValue([reaction]);

        const result = await useCase.execute(orgAndTeam, [42]);

        expect(
            codeManagementService.getPullRequestReviewComment,
        ).toHaveBeenCalled();
        expect(codeManagementService.countReactions).toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            reactions: { thumbsUp: 1, thumbsDown: 0 },
            suggestionId: 'suggestion-001',
            organizationId: orgAndTeam.organizationId,
        });
    });

    it('should match comments by threadId (GitLab/Azure pattern)', async () => {
        const pr = createSamplePullRequestWithSuggestions({
            suggestions: [
                {
                    id: 'suggestion-001',
                    deliveryStatus: 'DELIVERED' as any,
                    comment: { id: 500, pullRequestReviewId: null },
                },
            ],
        });
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr],
        );

        // Comment has threadId=500 matching suggestion's comment.id=500
        // but the comment's own id is 999 (platform-specific)
        const comment = createSampleComment({
            id: 999,
            threadId: 500,
        });
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            comment,
        ]);

        // countReactions returns reaction with comment.id=999 (the platform comment ID)
        // The new mapping resolves 999 → suggestion via reactionCommentIdToSuggestion
        const reaction = createSampleReactionResult({
            comment: { id: 999 },
        });
        codeManagementService.countReactions.mockResolvedValue([reaction]);

        const result = await useCase.execute(orgAndTeam, [42]);

        expect(codeManagementService.countReactions).toHaveBeenCalledWith(
            expect.objectContaining({
                comments: [expect.objectContaining({ threadId: 500 })],
            }),
        );
        expect(result).toHaveLength(1);
        expect(result[0].suggestionId).toBe('suggestion-001');
    });

    it('should match comments by notes[0].id (GitLab notes pattern)', async () => {
        const pr = createSamplePullRequestWithSuggestions({
            suggestions: [
                {
                    id: 'suggestion-001',
                    deliveryStatus: 'DELIVERED' as any,
                    comment: { id: 700, pullRequestReviewId: null },
                },
            ],
        });
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr],
        );

        // Comment thread with notes[0].id=700 matching suggestion's comment.id=700
        const comment = {
            id: 888,
            notes: [{ id: 700 }, { id: 701 }],
            reactions: { thumbsUp: 0, thumbsDown: 0 },
        };
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            comment,
        ]);

        // countReactions returns reaction with noteId=700
        // The new mapping registers both note IDs (700, 701) → suggestion
        const reaction = createSampleReactionResult({
            comment: { id: 700 },
        });
        codeManagementService.countReactions.mockResolvedValue([reaction]);

        const result = await useCase.execute(orgAndTeam, [42]);

        expect(codeManagementService.countReactions).toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].suggestionId).toBe('suggestion-001');
    });

    it('should filter out comments not linked to suggestions', async () => {
        const pr = createSamplePullRequestWithSuggestions();
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr],
        );

        // Comments with IDs that don't match any suggestion
        const unrelatedComment = createSampleComment({ id: 9999 });
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            unrelatedComment,
        ]);

        const result = await useCase.execute(orgAndTeam, [42]);

        // No comments linked → countReactions not called
        expect(codeManagementService.countReactions).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('should process multiple PRs in parallel', async () => {
        const pr1 = createSamplePullRequestWithSuggestions({
            _id: 'pr-1',
            number: 10,
        });
        const pr2 = createSamplePullRequestWithSuggestions({
            _id: 'pr-2',
            number: 20,
            suggestions: [
                {
                    id: 'suggestion-003',
                    deliveryStatus: 'DELIVERED' as any,
                    comment: { id: 300, pullRequestReviewId: null },
                },
            ],
        });
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr1, pr2],
        );

        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            createSampleComment({ id: 100 }),
        ]);

        codeManagementService.countReactions.mockResolvedValue([
            createSampleReactionResult(),
        ]);

        const result = await useCase.execute(orgAndTeam, [10, 20]);

        // Called once per PR
        expect(
            codeManagementService.getPullRequestReviewComment,
        ).toHaveBeenCalledTimes(2);
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should isolate PR failure and return [] for that PR without affecting others', async () => {
        const pr1 = createSamplePullRequestWithSuggestions({
            _id: 'pr-1',
            number: 10,
        });
        const pr2 = createSamplePullRequestWithSuggestions({
            _id: 'pr-2',
            number: 20,
        });
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr1, pr2],
        );

        // PR 10 fails, PR 20 succeeds
        codeManagementService.getPullRequestReviewComment
            .mockRejectedValueOnce(
                new Error("Repository service for type 'null' not found."),
            )
            .mockResolvedValueOnce([createSampleComment({ id: 100 })]);

        codeManagementService.countReactions.mockResolvedValue([
            createSampleReactionResult(),
        ]);

        const result = await useCase.execute(orgAndTeam, [10, 20]);

        // PR 10 error is isolated — PR 20 reactions still returned
        expect(result).toHaveLength(1);
        expect(result[0].suggestionId).toBe('suggestion-001');
    });
});
