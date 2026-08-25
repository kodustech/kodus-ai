import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import pLimit from 'p-limit';

import {
    PULL_REQUESTS_SERVICE_TOKEN,
    IPullRequestsService,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestWithDeliveredSuggestions } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { ReactionSyncAbortedError } from '@libs/code-review/domain/codeReviewFeedback/errors/reaction-sync-aborted.error';
import { ICollectedReaction } from '@libs/code-review/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/**
 * PRs processed at a time. Every PR costs one comment listing plus one request
 * per Kody comment on providers without inline reaction counts (GitLab), so an
 * unbounded `Promise.all` over a week of PRs meant a burst the size of "every
 * Kody comment in the org, at once".
 *
 * The cap is per run, and runs are already bounded by the queue prefetch, so
 * this is about not letting one tenant flood its own provider rather than about
 * a global budget. Multiplied by the GitLab award cap it holds a run to 50
 * simultaneous requests — low enough to be invisible to the instance, high
 * enough that a large tenant still finishes inside the handler timeout.
 */
const PR_CONCURRENCY = 10;

/**
 * Rate-limited PRs tolerated before the run gives up. Pressing on is worse than
 * useless once the provider starts refusing: every PR still in flight is
 * drawing on the same exhausted bucket, so continuing only extends the outage
 * we are causing. One PR can be unlucky; three means the instance is saying no.
 */
const RATE_LIMIT_FAILURES_BEFORE_ABORT = 3;

/**
 * Wall-clock budget for one run, deliberately under the consumer's
 * FEEDBACK_HANDLER_TIMEOUT_MS (5 min).
 *
 * The consumer's timeout is a `Promise.race`, which resolves the handler but
 * cancels nothing — the fan-out keeps running orphaned while the message is
 * already settled. Stopping ourselves first means the run ends on its own
 * terms: the caller still receives what was collected and persists it, instead
 * of the work being dropped mid-flight.
 */
const RUN_BUDGET_MS = 4 * 60 * 1000;

@Injectable()
export class GetReactionsUseCase implements IUseCase {
    private readonly logger = createLogger(GetReactionsUseCase.name);
    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
    ) {}

    /**
     * Reads the current reaction counts for every delivered suggestion in
     * range. Suggestions already stored are deliberately read again: the counts
     * are absolute values that keep moving after the first sync, and the caller
     * refreshes what changed. Skipping them would freeze the count at whatever
     * it was the first time it was seen — which is the bug this feature had.
     */
    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        automationExecutionsPRs: number[],
    ): Promise<ICollectedReaction[]> {
        if (!automationExecutionsPRs?.length) {
            return [];
        }

        const pullRequests =
            await this.pullRequestService.findPullRequestsWithDeliveredSuggestions(
                organizationAndTeamData.organizationId,
                automationExecutionsPRs,
                [PullRequestState.MERGED, PullRequestState.CLOSED],
            );

        if (!pullRequests?.length) {
            return [];
        }

        return await this.getReactions(pullRequests, organizationAndTeamData);
    }

    private async getReactions(
        pullRequests: IPullRequestWithDeliveredSuggestions[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ICollectedReaction[]> {
        const limit = pLimit(PR_CONCURRENCY);
        let rateLimitFailures = 0;
        let aborted = false;
        let resetAt: Date | undefined;

        const deadline = Date.now() + RUN_BUDGET_MS;
        let prsSkippedByDeadline = 0;

        // Observation only — these separate the three ways a PR can end up
        // with no reactions, which used to be indistinguishable in the logs:
        // the provider returned no comments, it returned comments but none
        // matched a suggestion, or they matched and every count was zero.
        let totalCommentsReturned = 0;
        let totalCommentsLinked = 0;
        let totalReactionsFound = 0;

        // Logged before any provider call so a run that later times out can
        // still be sized from the logs — otherwise a timeout says nothing
        // about whether it was 50 PRs or 5000.
        this.logger.log({
            message: 'Reaction sync run started',
            context: GetReactionsUseCase.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                totalPRs: pullRequests.length,
                totalSuggestions: pullRequests.reduce(
                    (total, pr) => total + (pr.suggestions?.length ?? 0),
                    0,
                ),
                prConcurrency: PR_CONCURRENCY,
            },
        });

        const reactionsPromises = pullRequests.map((pr) =>
            limit(async (): Promise<ICollectedReaction[]> => {
                if (aborted) {
                    return [];
                }

                // Checked here rather than mid-PR so a PR is either processed
                // whole or not started — a half-processed PR would report
                // fewer reactions than it has and the caller would treat that
                // as a real count.
                if (Date.now() > deadline) {
                    prsSkippedByDeadline += 1;
                    return [];
                }

                try {
                    if (!pr.suggestions?.length) {
                        return [];
                    }

                    const suggestionsByCommentId = new Map(
                        pr.suggestions.map((s) => [s.comment?.id, s]),
                    );

                    const comments =
                        await this.codeManagementService.getPullRequestReviewComment(
                            {
                                organizationAndTeamData,
                                filters: {
                                    repository: pr.repository,
                                    pullRequestNumber: pr.number,
                                },
                            },
                        );

                    const reactionCommentIdToSuggestion = new Map();
                    const commentsLinkedToSuggestions = comments.filter(
                        (comment) => {
                            const threadId =
                                comment?.threadId ??
                                comment?.notes?.[0]?.id ??
                                comment?.id;
                            const suggestion =
                                suggestionsByCommentId.get(threadId);

                            if (!suggestion) {
                                return false;
                            }

                            if (comment.notes?.length > 0) {
                                comment.notes.forEach((note) =>
                                    reactionCommentIdToSuggestion.set(
                                        note.id,
                                        suggestion,
                                    ),
                                );
                            } else {
                                reactionCommentIdToSuggestion.set(
                                    comment.id,
                                    suggestion,
                                );
                            }
                            return true;
                        },
                    );

                    totalCommentsReturned += comments?.length ?? 0;
                    totalCommentsLinked += commentsLinkedToSuggestions.length;

                    if (!commentsLinkedToSuggestions.length) {
                        this.logPrOutcome(pr, organizationAndTeamData, {
                            commentsReturned: comments?.length ?? 0,
                            commentsLinked: 0,
                            reactionsFound: 0,
                        });
                        return [];
                    }

                    const reactionsInComments =
                        await this.codeManagementService.countReactions({
                            organizationAndTeamData,
                            comments: commentsLinkedToSuggestions,
                            pr: {
                                pull_number: pr.number,
                                repository: pr.repository,
                            },
                        });

                    totalReactionsFound += reactionsInComments?.length ?? 0;

                    this.logPrOutcome(pr, organizationAndTeamData, {
                        commentsReturned: comments?.length ?? 0,
                        commentsLinked: commentsLinkedToSuggestions.length,
                        reactionsFound: reactionsInComments?.length ?? 0,
                    });

                    if (!reactionsInComments?.length) {
                        return [];
                    }

                    return reactionsInComments
                        .map((reaction) => {
                            const suggestion =
                                reactionCommentIdToSuggestion.get(
                                    reaction.comment.id,
                                );
                            if (!suggestion) {
                                return null;
                            }

                            return {
                                reactions: reaction.reactions,
                                comment: {
                                    id: reaction.comment.id,
                                    pullRequestReviewId:
                                        reaction.comment
                                            ?.pull_request_review_id,
                                },
                                suggestionId: suggestion.id,
                                pullRequest: {
                                    id: reaction.pullRequest.id,
                                    number: reaction.pullRequest.number,
                                    repository: {
                                        id:
                                            reaction?.pullRequest?.repository
                                                ?.id || pr?.repository?.id,
                                        fullName:
                                            reaction?.pullRequest?.repository
                                                ?.fullName ||
                                            pr?.repository?.name,
                                    },
                                },
                                organizationId:
                                    organizationAndTeamData.organizationId,
                            };
                        })
                        .filter((reaction) => reaction !== null);
                } catch (error) {
                    if (isRateLimitError(error)) {
                        rateLimitFailures += 1;
                        resetAt = error.resetAt;
                        aborted =
                            rateLimitFailures >=
                            RATE_LIMIT_FAILURES_BEFORE_ABORT;

                        this.logger.warn({
                            message:
                                'Provider rate limit hit while syncing reactions',
                            context: GetReactionsUseCase.name,
                            error,
                            metadata: {
                                organizationId:
                                    organizationAndTeamData.organizationId,
                                teamId: organizationAndTeamData.teamId,
                                prNumber: pr.number,
                                repository: pr?.repository?.name,
                                rateLimitFailures,
                                failuresBeforeAbort:
                                    RATE_LIMIT_FAILURES_BEFORE_ABORT,
                                aborted,
                            },
                        });

                        return [];
                    }

                    this.logger.error({
                        message: 'Failed to fetch reactions for PR',
                        context: GetReactionsUseCase.name,
                        error,
                        metadata: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId: organizationAndTeamData.teamId,
                            prNumber: pr.number,
                            repository: pr?.repository?.name,
                            suggestionsCount: pr.suggestions?.length || 0,
                        },
                    });
                    return [];
                }
            }),
        );

        const reactionsResults = await Promise.all(reactionsPromises);
        const flattenedReactions = reactionsResults.flat();

        if (aborted) {
            const abortResetAt = resetAt ?? new Date();

            // The caller's catch-all reports this as a generic save failure,
            // which reads as a bug rather than the deliberate backoff it is.
            // This line is what tells you it was the breaker, how much survived
            // and when the retry is due.
            this.logger.warn({
                message: 'Reaction sync aborted by rate-limit breaker',
                context: GetReactionsUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    rateLimitFailures,
                    totalPRs: pullRequests.length,
                    prsCompleted: reactionsResults.filter(
                        (result) => result.length > 0,
                    ).length,
                    partialReactions: flattenedReactions.length,
                    resetAt: abortResetAt.toISOString(),
                },
            });

            throw new ReactionSyncAbortedError({
                // The adapter derives this from the provider's rate-limit
                // window; the handler adds its own safety buffer on top.
                resetAt: abortResetAt,
                message: `Reaction sync aborted after ${rateLimitFailures} rate-limited PRs`,
                partialReactions: flattenedReactions,
                context: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });
        }

        const prsWithoutReactions = pullRequests.filter((pr, index) => {
            return reactionsResults[index].length === 0;
        });

        if (prsWithoutReactions.length > 0) {
            this.logger.log({
                message: 'PRs without reactions summary',
                context: GetReactionsUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    totalPRs: pullRequests.length,
                    prsWithReactions:
                        pullRequests.length - prsWithoutReactions.length,
                    prsWithoutReactions: prsWithoutReactions.length,
                },
            });

            // One entry per PR without reactions, and most Kody comments never
            // get a thumbs — in a large tenant this is nearly every PR of the
            // window in a single line.
            this.logger.debug({
                message: 'PRs without reactions detail',
                context: GetReactionsUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    prsWithoutReactionsDetails: prsWithoutReactions.map(
                        (pr) => ({
                            prNumber: pr.number,
                            repository: pr?.repository?.name,
                            suggestionsCount: pr.suggestions?.length || 0,
                        }),
                    ),
                },
            });
        }

        if (prsSkippedByDeadline > 0) {
            this.logger.warn({
                message: 'Reaction sync stopped on its own time budget',
                context: GetReactionsUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    totalPRs: pullRequests.length,
                    prsSkippedByDeadline,
                    budgetMs: RUN_BUDGET_MS,
                    collectedReactions: flattenedReactions.length,
                },
            });
        }

        // The one line that makes "synced nothing" diagnosable at the default
        // log level: it says whether the provider returned comments at all,
        // whether they matched our suggestions, and whether anyone reacted.
        this.logger.log({
            message: 'Reaction sync run finished',
            context: GetReactionsUseCase.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                totalPRs: pullRequests.length,
                commentsReturned: totalCommentsReturned,
                commentsLinked: totalCommentsLinked,
                reactionsFound: totalReactionsFound,
                collectedReactions: flattenedReactions.length,
            },
        });

        return flattenedReactions;
    }

    private logPrOutcome(
        pr: IPullRequestWithDeliveredSuggestions,
        organizationAndTeamData: OrganizationAndTeamData,
        counts: {
            commentsReturned: number;
            commentsLinked: number;
            reactionsFound: number;
        },
    ): void {
        this.logger.debug({
            message: 'Reaction lookup for PR',
            context: GetReactionsUseCase.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                prNumber: pr.number,
                repository: pr?.repository?.name,
                suggestionsCount: pr.suggestions?.length ?? 0,
                ...counts,
            },
        });
    }
}
