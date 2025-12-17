import { UserRequest } from '@/config/types/http/user-request.type';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import {
    CODE_REVIEW_EXECUTION_SERVICE,
    ICodeReviewExecutionService,
} from '@/core/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { IPullRequests } from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { AuthorizationService } from '@/core/infrastructure/adapters/services/permissions/authorization.service';
import { EnrichedPullRequestResponse } from '@/core/infrastructure/http/dtos/enriched-pull-request-response.dto';
import { EnrichedPullRequestsQueryDto } from '@/core/infrastructure/http/dtos/enriched-pull-requests-query.dto';
import {
    PaginatedEnrichedPullRequestsResponse,
    PaginationMetadata,
} from '@/core/infrastructure/http/dtos/paginated-enriched-pull-requests.dto';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetEnrichedPullRequestsUseCase implements IUseCase {
    constructor(
        private readonly logger: PinoLoggerService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(CODE_REVIEW_EXECUTION_SERVICE)
        private readonly codeReviewExecutionService: ICodeReviewExecutionService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(
        query: EnrichedPullRequestsQueryDto,
    ): Promise<PaginatedEnrichedPullRequestsResponse> {
        const {
            repositoryId,
            repositoryName,
            limit = 30,
            page = 1,
            hasSentSuggestions,
            pullRequestTitle,
            teamId,
        } = query;

        if (!this.request.user?.organization?.uuid) {
            this.logger.warn({
                message: 'No organization found in request',
                context: GetEnrichedPullRequestsUseCase.name,
            });
            throw new Error('No organization found in request');
        }

        if (repositoryId) {
            await this.authorizationService.ensure({
                user: this.request.user,
                action: Action.Read,
                resource: ResourceType.PullRequests,
                repoIds: [repositoryId],
            });
        }

        const organizationId = this.request.user.organization.uuid;

        try {
            const assignedRepositoryIds =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.PullRequests,
                });

            const allowedRepositoryIds = (() => {
                if (repositoryId) {
                    return [repositoryId];
                }

                if (assignedRepositoryIds !== null) {
                    return assignedRepositoryIds;
                }

                return undefined;
            })();

            const enrichedPullRequests: EnrichedPullRequestResponse[] = [];
            const initialSkip = (page - 1) * limit;
            let accumulatedExecutions = 0;
            let totalExecutions = 0;
            let hasMoreExecutions = true;

            while (enrichedPullRequests.length < limit && hasMoreExecutions) {
                const { data: executionsBatch, total } =
                    await this.automationExecutionService.findPullRequestExecutionsByOrganizationAndTeam(
                        {
                            organizationAndTeamData: {
                                organizationId,
                                teamId,
                            },
                            repositoryIds: allowedRepositoryIds,
                            skip: initialSkip + accumulatedExecutions,
                            take: limit,
                            order: 'DESC',
                        },
                    );

                if (totalExecutions === 0) {
                    totalExecutions = total;
                }

                if (!executionsBatch.length) {
                    hasMoreExecutions = false;
                    break;
                }

                for (const execution of executionsBatch) {
                    try {
                        const pullRequest =
                            await this.pullRequestsService.findByNumberAndRepositoryId(
                                execution.pullRequestNumber!,
                                execution.repositoryId!,
                                { organizationId },
                            );

                        if (
                            pullRequestTitle &&
                            !pullRequest?.title
                                .toLocaleLowerCase()
                                .includes(pullRequestTitle.toLocaleLowerCase())
                        ) {
                            continue;
                        }

                        if (!pullRequest) {
                            this.logger.warn({
                                message: 'Pull request not found in MongoDB',
                                context: GetEnrichedPullRequestsUseCase.name,
                                metadata: {
                                    prNumber: execution.pullRequestNumber,
                                    repositoryId: execution.repositoryId,
                                    organizationId,
                                },
                            });
                            continue;
                        }

                        if (
                            repositoryName &&
                            pullRequest.repository.name !== repositoryName
                        ) {
                            continue;
                        }

                        const codeReviewExecutions =
                            await this.codeReviewExecutionService.find({
                                automationExecution: { uuid: execution.uuid },
                            });

                        if (
                            !codeReviewExecutions ||
                            codeReviewExecutions.length === 0
                        ) {
                            this.logger.debug({
                                message:
                                    'Skipping PR without code review history',
                                context: GetEnrichedPullRequestsUseCase.name,
                                metadata: {
                                    prNumber: execution.pullRequestNumber,
                                    repositoryId: execution.repositoryId,
                                    executionUuid: execution.uuid,
                                },
                            });
                            continue;
                        }

                        const codeReviewTimeline = codeReviewExecutions.map(
                            (cre) => ({
                                uuid: cre.uuid,
                                createdAt: cre.createdAt,
                                updatedAt: cre.updatedAt,
                                status: cre.status,
                                message: cre.message,
                            }),
                        );

                        const enrichedData = this.extractEnrichedData(
                            execution.dataExecution,
                        );

                        const suggestionsCount =
                            this.extractSuggestionsCount(pullRequest);

                        if (
                            hasSentSuggestions === true &&
                            suggestionsCount?.sent <= 0
                        ) {
                            continue;
                        } else if (
                            hasSentSuggestions === false &&
                            suggestionsCount?.sent > 0
                        ) {
                            continue;
                        }

                        const enrichedPR: EnrichedPullRequestResponse = {
                            prId: pullRequest.uuid!,
                            prNumber: pullRequest.number,
                            title: pullRequest.title,
                            status: pullRequest.status,
                            merged: pullRequest.merged,
                            url: pullRequest.url,
                            baseBranchRef: pullRequest.baseBranchRef,
                            headBranchRef: pullRequest.headBranchRef,
                            repositoryName: pullRequest.repository.name,
                            repositoryId: pullRequest.repository.id,
                            openedAt: pullRequest.openedAt,
                            closedAt: pullRequest.closedAt,
                            createdAt: pullRequest.createdAt,
                            updatedAt: pullRequest.updatedAt,
                            provider: pullRequest.provider,
                            author: {
                                id: pullRequest.user.id,
                                username: pullRequest.user.username,
                                name: pullRequest.user.name,
                            },
                            isDraft: pullRequest.isDraft,
                            automationExecution: {
                                uuid: execution.uuid,
                                status: execution.status,
                                errorMessage: execution.errorMessage,
                                createdAt: execution.createdAt!,
                                updatedAt: execution.updatedAt!,
                                origin: execution.origin,
                            },
                            codeReviewTimeline,
                            enrichedData,
                            suggestionsCount,
                        };

                        enrichedPullRequests.push(enrichedPR);
                    } catch (error) {
                        this.logger.error({
                            message: 'Error processing automation execution',
                            context: GetEnrichedPullRequestsUseCase.name,
                            error,
                            metadata: {
                                executionUuid: execution.uuid,
                                prNumber: execution.pullRequestNumber,
                                repositoryId: execution.repositoryId,
                            },
                        });
                    }

                    if (enrichedPullRequests.length >= limit) {
                        break;
                    }
                }

                accumulatedExecutions += executionsBatch.length;

                if (initialSkip + accumulatedExecutions >= totalExecutions) {
                    hasMoreExecutions = false;
                }
            }

            if (totalExecutions === 0) {
                this.logger.warn({
                    message: 'No automation executions with PR data found',
                    context: GetEnrichedPullRequestsUseCase.name,
                    metadata: { organizationId },
                });
                return {
                    data: [],
                    pagination: {
                        currentPage: page,
                        totalPages: 0,
                        totalItems: 0,
                        itemsPerPage: limit,
                        hasNextPage: false,
                        hasPreviousPage: false,
                    },
                };
            }

            const paginatedData = enrichedPullRequests.slice(0, limit);

            const totalPages = Math.ceil(totalExecutions / limit);
            const paginationMetadata: PaginationMetadata = {
                currentPage: page,
                totalPages,
                totalItems: totalExecutions,
                itemsPerPage: limit,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            };

            this.logger.log({
                message:
                    'Successfully retrieved enriched pull requests with code review history',
                context: GetEnrichedPullRequestsUseCase.name,
                metadata: {
                    organizationId,
                    totalExecutions,
                    returnedItems: paginatedData.length,
                    page,
                    limit,
                },
            });

            return {
                data: paginatedData,
                pagination: paginationMetadata,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error getting enriched pull requests',
                context: GetEnrichedPullRequestsUseCase.name,
                error,
                metadata: { repositoryId, repositoryName },
            });
            throw error;
        }
    }

    private extractEnrichedData(dataExecution: any) {
        if (!dataExecution) return undefined;

        return {
            repository: dataExecution.repository
                ? {
                      id: dataExecution.repository.id,
                      name: dataExecution.repository.name,
                  }
                : undefined,
            pullRequest: dataExecution.pullRequest
                ? {
                      number: dataExecution.pullRequest.number,
                      title: dataExecution.pullRequest.title,
                      url: dataExecution.pullRequest.url,
                  }
                : undefined,
            team: dataExecution.team
                ? {
                      name: dataExecution.team.name,
                      uuid: dataExecution.team.uuid,
                  }
                : undefined,
            automation: dataExecution.automation
                ? {
                      name: dataExecution.automation.name,
                      type: dataExecution.automation.type,
                  }
                : undefined,
        };
    }

    private extractSuggestionsCount(pullRequest: IPullRequests): {
        sent: number;
        filtered: number;
    } {
        return (pullRequest.files ?? []).reduce(
            (
                acc: { sent: number; filtered: number },
                file: IPullRequests['files'][number],
            ) => {
                for (const { deliveryStatus } of file.suggestions ?? []) {
                    if (deliveryStatus === DeliveryStatus.SENT) acc.sent += 1;
                    else if (deliveryStatus === DeliveryStatus.NOT_SENT)
                        acc.filtered += 1;
                }
                return acc;
            },
            { sent: 0, filtered: 0 },
        );
    }
}
