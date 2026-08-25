import { GetReactionsUseCase } from '../get-reactions.use-case';
import { ReactionSyncAbortedError } from '@libs/code-review/domain/codeReviewFeedback/errors/reaction-sync-aborted.error';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import {
    isRateLimitError,
    RateLimitError,
} from '@libs/core/workflow/domain/errors/rate-limit.error';
import {
    createSampleOrganizationAndTeamData,
    createSamplePullRequestWithSuggestions,
    createSampleComment,
    createSampleReactionResult,
} from './fixtures';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
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

    it('should re-read suggestions that were already synced, so moving counts are seen', async () => {
        const pr = createSamplePullRequestWithSuggestions();
        pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
            [pr],
        );
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            createSampleComment({ id: 100 }),
        ]);
        codeManagementService.countReactions.mockResolvedValue([
            createSampleReactionResult({
                reactions: { thumbsUp: 4, thumbsDown: 0 },
            }),
        ]);

        const result = await useCase.execute(orgAndTeam, [42]);

        // Nothing here filters on prior state — the current count always wins
        expect(codeManagementService.countReactions).toHaveBeenCalled();
        expect(result[0].reactions).toEqual({ thumbsUp: 4, thumbsDown: 0 });
    });

    describe('concurrency', () => {
        it('should never have more than PR_CONCURRENCY PRs in flight', async () => {
            const prs = Array.from({ length: 20 }, (_, i) =>
                createSamplePullRequestWithSuggestions({
                    _id: `pr-${i}`,
                    number: i + 1,
                }),
            );
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );

            let inFlight = 0;
            let peakInFlight = 0;
            codeManagementService.getPullRequestReviewComment.mockImplementation(
                async () => {
                    inFlight += 1;
                    peakInFlight = Math.max(peakInFlight, inFlight);
                    await new Promise((resolve) => setImmediate(resolve));
                    inFlight -= 1;
                    return [createSampleComment({ id: 100 })];
                },
            );
            codeManagementService.countReactions.mockResolvedValue([]);

            await useCase.execute(
                orgAndTeam,
                prs.map((pr) => pr.number),
            );

            expect(
                codeManagementService.getPullRequestReviewComment,
            ).toHaveBeenCalledTimes(20);
            expect(peakInFlight).toBeLessThanOrEqual(10);
        });
    });

    describe('rate-limit breaker', () => {
        const rateLimitError = () =>
            new RateLimitError({
                resetAt: new Date('2026-08-20T00:01:00.000Z'),
                message: 'GitLab refused the request rate',
            });

        const manyPrs = (count: number) =>
            Array.from({ length: count }, (_, i) =>
                createSamplePullRequestWithSuggestions({
                    _id: `pr-${i}`,
                    number: i + 1,
                }),
            );

        it('should tolerate rate limits below the abort threshold', async () => {
            const prs = manyPrs(3);
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );

            codeManagementService.getPullRequestReviewComment
                .mockRejectedValueOnce(rateLimitError())
                .mockRejectedValueOnce(rateLimitError())
                .mockResolvedValue([createSampleComment({ id: 100 })]);
            codeManagementService.countReactions.mockResolvedValue([
                createSampleReactionResult(),
            ]);

            const result = await useCase.execute(orgAndTeam, [1, 2, 3]);

            expect(result).toHaveLength(1);
        });

        it('should abort the run once the threshold is reached', async () => {
            const prs = manyPrs(3);
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );

            codeManagementService.getPullRequestReviewComment.mockRejectedValue(
                rateLimitError(),
            );

            await expect(
                useCase.execute(orgAndTeam, [1, 2, 3]),
            ).rejects.toBeInstanceOf(ReactionSyncAbortedError);
        });

        it('should stop issuing provider calls for PRs still queued after aborting', async () => {
            const prs = manyPrs(40);
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );

            codeManagementService.getPullRequestReviewComment.mockImplementation(
                async () => {
                    throw rateLimitError();
                },
            );

            await expect(
                useCase.execute(
                    orgAndTeam,
                    prs.map((pr) => pr.number),
                ),
            ).rejects.toBeInstanceOf(ReactionSyncAbortedError);

            // Only the first concurrency window runs; the queue drains without
            // touching the provider once the breaker opens.
            expect(
                codeManagementService.getPullRequestReviewComment.mock.calls
                    .length,
            ).toBeLessThanOrEqual(10);
        });

        it('should carry reactions already collected on the abort error', async () => {
            const prs = manyPrs(4);
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );

            // First PR succeeds, the rest are rate limited
            codeManagementService.getPullRequestReviewComment
                .mockResolvedValueOnce([createSampleComment({ id: 100 })])
                .mockRejectedValue(rateLimitError());
            codeManagementService.countReactions.mockResolvedValue([
                createSampleReactionResult(),
            ]);

            const error = await useCase
                .execute(orgAndTeam, [1, 2, 3, 4])
                .catch((e) => e);

            expect(error).toBeInstanceOf(ReactionSyncAbortedError);
            expect(error.partialReactions).toHaveLength(1);
            expect(error.partialReactions[0].suggestionId).toBe(
                'suggestion-001',
            );
        });

        it('should expose the provider reset window so the consumer can reschedule', async () => {
            const prs = manyPrs(3);
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );
            codeManagementService.getPullRequestReviewComment.mockRejectedValue(
                rateLimitError(),
            );

            const error = await useCase
                .execute(orgAndTeam, [1, 2, 3])
                .catch((e) => e);

            expect(isRateLimitError(error)).toBe(true);
            expect(error.resetAt).toEqual(new Date('2026-08-20T00:01:00.000Z'));
        });

        it('should not abort on ordinary errors, however many', async () => {
            const prs = manyPrs(6);
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );
            codeManagementService.getPullRequestReviewComment.mockRejectedValue(
                new Error('boom'),
            );

            const result = await useCase.execute(
                orgAndTeam,
                prs.map((pr) => pr.number),
            );

            expect(result).toEqual([]);
            expect(
                codeManagementService.getPullRequestReviewComment,
            ).toHaveBeenCalledTimes(6);
        });
    });

    /**
     * A run that finds nothing used to look identical in the logs whether the
     * provider returned no comments at all, returned comments that matched no
     * suggestion, or matched them and found every count at zero. Three
     * different causes, one log line — which is exactly what blocked the live
     * debugging of a "synced nothing" report.
     */
    describe('why a run found nothing', () => {
        const runAndReadSummary = async () => {
            const logger = (useCase as any).logger;
            await useCase.execute(orgAndTeam, [42]);

            const summary = logger.log.mock.calls
                .map(([entry]: [any]) => entry)
                .find(
                    (entry: any) =>
                        entry.message === 'Reaction sync run finished',
                );

            return summary?.metadata;
        };

        beforeEach(() => {
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                [createSamplePullRequestWithSuggestions()],
            );
        });

        it('distinguishes "the provider returned no comments"', async () => {
            codeManagementService.getPullRequestReviewComment.mockResolvedValue(
                [],
            );

            expect(await runAndReadSummary()).toMatchObject({
                commentsReturned: 0,
                commentsLinked: 0,
                reactionsFound: 0,
            });
        });

        it('distinguishes "comments came back but none matched a suggestion"', async () => {
            codeManagementService.getPullRequestReviewComment.mockResolvedValue(
                [
                    createSampleComment({ id: 9998 }),
                    createSampleComment({ id: 9999 }),
                ],
            );

            expect(await runAndReadSummary()).toMatchObject({
                commentsReturned: 2,
                commentsLinked: 0,
                reactionsFound: 0,
            });
            // The distinguishing signal: countReactions is never reached
            expect(codeManagementService.countReactions).not.toHaveBeenCalled();
        });

        it('distinguishes "they matched but nobody reacted"', async () => {
            codeManagementService.getPullRequestReviewComment.mockResolvedValue(
                [createSampleComment({ id: 100 })],
            );
            codeManagementService.countReactions.mockResolvedValue([]);

            expect(await runAndReadSummary()).toMatchObject({
                commentsReturned: 1,
                commentsLinked: 1,
                reactionsFound: 0,
            });
            expect(codeManagementService.countReactions).toHaveBeenCalled();
        });

        it('reports the counts of a run that did find reactions', async () => {
            codeManagementService.getPullRequestReviewComment.mockResolvedValue(
                [createSampleComment({ id: 100 })],
            );
            codeManagementService.countReactions.mockResolvedValue([
                createSampleReactionResult(),
            ]);

            expect(await runAndReadSummary()).toMatchObject({
                commentsReturned: 1,
                commentsLinked: 1,
                reactionsFound: 1,
                collectedReactions: 1,
            });
        });
    });

    describe('run time budget', () => {
        it('stops starting new PRs once the budget is spent and keeps what it collected', async () => {
            const prs = Array.from({ length: 30 }, (_, i) =>
                createSamplePullRequestWithSuggestions({
                    _id: `pr-${i}`,
                    number: i + 1,
                }),
            );
            pullRequestService.findPullRequestsWithDeliveredSuggestions.mockResolvedValue(
                prs,
            );

            // First concurrency window resolves normally, then time jumps past
            // the budget so everything still queued is dropped unstarted.
            const realNow = Date.now;
            let callCount = 0;
            codeManagementService.getPullRequestReviewComment.mockImplementation(
                async () => {
                    callCount += 1;
                    if (callCount === 10) {
                        const jumped = realNow() + 10 * 60 * 1000;
                        jest.spyOn(Date, 'now').mockImplementation(
                            () => jumped,
                        );
                    }
                    return [createSampleComment({ id: 100 })];
                },
            );
            codeManagementService.countReactions.mockResolvedValue([
                createSampleReactionResult(),
            ]);

            const result = await useCase.execute(
                orgAndTeam,
                prs.map((pr) => pr.number),
            );

            expect(
                codeManagementService.getPullRequestReviewComment.mock.calls
                    .length,
            ).toBeLessThan(30);
            // Partial work survives — it is handed back, not thrown away
            expect(result.length).toBeGreaterThan(0);

            jest.spyOn(Date, 'now').mockRestore();
        });
    });
});
