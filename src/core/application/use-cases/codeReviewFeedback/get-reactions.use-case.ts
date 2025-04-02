import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PullRequestWithFiles } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import * as moment from 'moment-timezone';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import {
    PULL_REQUESTS_SERVICE_TOKEN,
    IPullRequestsService,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { ICodeReviewFeedback } from '@/core/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';

@Injectable()
export class GetReactionsUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
    ) {}

    async execute(organizationAndTeamData: OrganizationAndTeamData) {
        const period = this.calculatePeriod();

        const mergedPullRequests =
            await this.codeManagementService.getPullRequestsWithFiles({
                organizationAndTeamData: organizationAndTeamData,
                filters: {
                    period,
                    prStatus: 'merged',
                },
            });

        const closedPullRequests =
            await this.codeManagementService.getPullRequestsWithFiles({
                organizationAndTeamData: organizationAndTeamData,
                filters: {
                    period,
                    prStatus: 'closed',
                },
            });

        const allPullRequests = [...mergedPullRequests, ...closedPullRequests];

        return await this.getReactions(
            allPullRequests,
            organizationAndTeamData,
        );
    }

    private async getReactions(
        pullRequests: PullRequestWithFiles[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ICodeReviewFeedback[]> {
        const reactions: any[] = [];

        if (!pullRequests?.length) {
            return [];
        }

        for (const pr of pullRequests) {
            const comments =
                await this.codeManagementService.getPullRequestReviewComment({
                    organizationAndTeamData: organizationAndTeamData,
                    filters: {
                        repository: pr.repository,
                        pullRequestNumber: pr.pull_number,
                    },
                });

            const suggestions =
                await this.pullRequestService.findSuggestionsByPR(
                    organizationAndTeamData.organizationId,
                    pr.pull_number,
                    DeliveryStatus.SENT,
                );

            if (!suggestions?.length) {
                continue;
            }

            const commentsLinkedToSuggestions = comments.filter((comment) =>
                suggestions?.some(
                    (suggestion) =>
                        suggestion?.comment?.id ===
                        (comment?.notes?.[0]?.id || comment?.id),
                ),
            );

            const reactionsInComments =
                await this.codeManagementService.countReactions({
                    organizationAndTeamData: organizationAndTeamData,
                    comments: commentsLinkedToSuggestions,
                    pr,
                });

            // Adds the suggestionId to each reaction
            const reactionsWithSuggestionId = reactionsInComments
                .filter((reaction) =>
                    suggestions.some(
                        (s) => s?.comment?.id === reaction.comment.id,
                    ),
                )
                .map((reaction) => {
                    const suggestion = suggestions.find(
                        (s) => s?.comment?.id === reaction.comment.id,
                    );
                    return {
                        reactions: reaction.reactions,
                        comment: {
                            id: reaction.comment.id,
                            pullRequestReviewId:
                                reaction.comment?.pull_request_review_id,
                        },
                        suggestionId: suggestion?.id,
                        pullRequest: {
                            id: reaction.pullRequest.id,
                            number: reaction.pullRequest.number,
                            repository: {
                                id:
                                    reaction?.pullRequest?.repository?.id ||
                                    pr?.repositoryData?.id,
                                fullName:
                                    pr?.repositoryData?.fullName ||
                                    reaction?.pullRequest?.repository?.fullName,
                            },
                        },
                        organizationId: organizationAndTeamData.organizationId,
                    };
                });

            reactions.push(...reactionsWithSuggestionId);
        }

        return reactions;
    }

    private calculatePeriod() {
        const now = new Date();
        const endDate = now;
        const startDate = new Date(now);

        startDate.setDate(startDate.getDate() - 1);
        startDate.setHours(0, 0, 0, 0);

        return {
            startDate: moment(startDate).format('YYYY-MM-DD HH:mm'),
            endDate: moment(endDate).format('YYYY-MM-DD HH:mm'),
        };
    }
}
