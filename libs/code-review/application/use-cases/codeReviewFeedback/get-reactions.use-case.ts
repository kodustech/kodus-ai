import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import {
    PULL_REQUESTS_SERVICE_TOKEN,
    IPullRequestsService,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestWithDeliveredSuggestions } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

@Injectable()
export class GetReactionsUseCase implements IUseCase {
    private readonly logger = createLogger(GetReactionsUseCase.name);
    constructor(
        private readonly codeManagementService: CodeManagementService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        automationExecutionsPRs: number[],
    ) {
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
    ) {
        const reactionsPromises = pullRequests.map(async (pr) => {
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
                        const suggestion = suggestionsByCommentId.get(threadId);

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

                if (!commentsLinkedToSuggestions.length) {
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

                if (!reactionsInComments?.length) {
                    return [];
                }

                return reactionsInComments
                    .map((reaction) => {
                        const suggestion = reactionCommentIdToSuggestion.get(
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
                                    reaction.comment?.pull_request_review_id,
                            },
                            suggestionId: suggestion.id,
                            pullRequest: {
                                id: reaction.pullRequest.id,
                                number: reaction.pullRequest.number,
                                repository: {
                                    id:
                                        reaction?.pullRequest?.repository?.id ||
                                        pr?.repository?.id,
                                    fullName:
                                        reaction?.pullRequest?.repository
                                            ?.fullName || pr?.repository?.name,
                                },
                            },
                            organizationId:
                                organizationAndTeamData.organizationId,
                        };
                    })
                    .filter((reaction) => reaction !== null);
            } catch (error) {
                this.logger.error({
                    message: 'Failed to fetch reactions for PR',
                    context: GetReactionsUseCase.name,
                    error,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        prNumber: pr.number,
                        repository: pr?.repository?.name,
                        suggestionsCount: pr.suggestions?.length || 0,
                    },
                });
                return [];
            }
        });

        const reactionsResults = await Promise.all(reactionsPromises);
        const flattenedReactions = reactionsResults.flat();

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

        return flattenedReactions;
    }
}
