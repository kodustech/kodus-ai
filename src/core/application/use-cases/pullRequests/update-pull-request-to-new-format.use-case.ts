import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/PullRequestManagerService.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PullRequestsEntity } from '@/core/domain/pullRequests/entities/pullRequests.entity';
import { PullRequestHandlerService } from '@/core/infrastructure/adapters/services/codeBase/pullRequestManager.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { updatePullRequestDto } from '@/core/infrastructure/http/dtos/update-pull-request.dto';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class UpdatePullRequestToNewFormatUseCase {
    constructor(
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestHandlerService: PullRequestHandlerService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        private readonly codeManagement: CodeManagementService,

        private readonly logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    private successfullyUpdatedPRs: number = 0;

    async execute(body: updatePullRequestDto) {
        try {
            const organizationId = body.organizationId;

            const pullRequests = await this.pullRequestService.find({
                organizationId: organizationId,
            });

            const organizationAndTeamData: OrganizationAndTeamData = {
                teamId: undefined,
                organizationId: organizationId,
            };

            this.logger.log({
                message: `Updating  ${pullRequests.length} pull requests from organization: ${organizationAndTeamData.organizationId}`,
                context: UpdatePullRequestToNewFormatUseCase.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                },
            });

            const processedPrs = await Promise.allSettled(
                pullRequests.map(async (pr) => {
                    try {
                        await this.processPR(pr, organizationAndTeamData);
                    } catch (error) {
                        this.logger.log({
                            message: `Failed to update process PR #${pr?.number}`,
                            context: UpdatePullRequestToNewFormatUseCase.name,
                            error: error,
                            metadata: {
                                pullRequestNumber: pr?.number,
                                repositoryName: pr?.repository?.name,
                                pullRequestProvider: pr?.provider,
                                pullRequestTitle: pr?.title,
                            },
                        });
                    }
                }),
            );

            this.logger.log({
                message: `Successfully updated  ${this.successfullyUpdatedPRs} (total PRs: ${pullRequests.length}) pull requests from organization: ${organizationAndTeamData.organizationId}`,
                context: UpdatePullRequestToNewFormatUseCase.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                },
            });

            return processedPrs;
        } catch (error) {
            this.logger.log({
                message: `Failed to update PRs from organization: ${body.organizationId ?? this.request.user.organization.uuid}`,
                context: UpdatePullRequestToNewFormatUseCase.name,
                error: error,
                metadata: {
                    organizationId:
                        body.organizationId ??
                        this.request.user.organization.uuid,
                },
            });

            throw error;
        }
    }
    private async processPR(
        pr: PullRequestsEntity,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const prInfo = {
            organizationAndTeamData,
            prNumber: pr.number,
            repository: pr.repository,
        };
        const provider = pr.provider as PlatformType;

        const prDetails = await this.codeManagement.getPullRequestByNumber(
            prInfo,
            provider,
        );

        await this.populateAssignees(prDetails, organizationAndTeamData);
        await this.populateReviewers(prDetails, organizationAndTeamData);

        const [prCommits, user, reviewers, assignees] = await this.fetchPRData(
            prInfo,
            provider,
            prDetails,
            organizationAndTeamData,
        );

        await this.pullRequestService.update(pr, {
            updatedAt: new Date().toISOString(),
            user,
            reviewers,
            assignees,
            commits: prCommits,
        });

        this.successfullyUpdatedPRs += 1;
    }

    private async populateAssignees(
        prDetails: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        if (!prDetails.assignees && prDetails.assignee_ids) {
            prDetails.assignees = await this.getUsers(
                organizationAndTeamData,
                prDetails.assignee_ids,
            );
        }
    }

    private async populateReviewers(
        prDetails: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        if (
            (!prDetails.reviewers || !prDetails.requested_reviewers) &&
            prDetails.reviewer_ids
        ) {
            prDetails.reviewers = await this.getUsers(
                organizationAndTeamData,
                prDetails.reviewer_ids,
            );
        }
    }

    private async fetchPRData(
        prInfo: any,
        provider: PlatformType,
        prDetails: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        return Promise.all([
            this.codeManagement.getCommitsForPullRequestForCodeReview(
                prInfo,
                provider,
            ),
            this.pullRequestService.extractUser(
                prDetails.user,
                organizationAndTeamData.organizationId,
                provider,
                prInfo.prNumber,
            ),
            this.pullRequestService.extractUsers(
                prDetails.reviewers ?? prDetails.requested_reviewers,
                organizationAndTeamData.organizationId,
                provider,
                prInfo.prNumber,
            ),
            this.pullRequestService.extractUsers(
                prDetails.assignees ?? prDetails.participants,
                organizationAndTeamData.organizationId,
                provider,
                prInfo.prNumber,
            ),
        ]);
    }

    private async getUsers(
        organizationAndTeamData: OrganizationAndTeamData,
        userIds: Array<string>,
    ) {
        const foundUsers = await Promise.all(
            userIds.map(async (id) => {
                const foundUser = await this.codeManagement.getUserById({
                    organizationAndTeamData,
                    userId: id,
                });
                return foundUser
                    ? {
                          id: foundUser.id,
                          username: foundUser.username,
                          name: foundUser.name,
                      }
                    : null;
            }),
        );

        return foundUsers.filter((user) => user !== null);
    }
}
