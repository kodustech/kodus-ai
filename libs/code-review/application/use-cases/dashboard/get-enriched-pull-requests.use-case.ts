import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { IPullRequests } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';
import {
    CODE_REVIEW_EXECUTION_SERVICE,
    ICodeReviewExecutionService,
} from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    PaginatedEnrichedPullRequestsResponse,
    PaginationMetadata,
} from '@libs/code-review/dtos/dashboard/paginated-enriched-pull-requests.dto';
import { EnrichedPullRequestsQueryDto } from '@libs/code-review/dtos/dashboard/enriched-pull-requests-query.dto';
import { EnrichedPullRequestResponse } from '@libs/code-review/dtos/dashboard/enriched-pull-request-response.dto';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersAutoAssignConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';
import { PullRequestAuthorPolicy } from '@libs/code-review/dtos/dashboard/pull-request-author-policy.constants';
import {
    compileAuthorPolicyConfig,
    shouldIncludeAuthorByPolicy,
} from './utils/author-policy-filter.util';

@Injectable()
export class GetEnrichedPullRequestsUseCase implements IUseCase {
    private readonly logger = createLogger(GetEnrichedPullRequestsUseCase.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(CODE_REVIEW_EXECUTION_SERVICE)
        private readonly codeReviewExecutionService: ICodeReviewExecutionService<IAutomationExecution>,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

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
            pullRequestNumber,
            teamId,
            authorPolicy = 'all',
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
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId,
        };

        try {
            const assignedRepositoryIds =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.PullRequests,
                });

            if (
                assignedRepositoryIds !== null &&
                assignedRepositoryIds.length === 0
            ) {
                return this.buildEmptyResponse(limit, page);
            }

            let requestedRepositoryIds: string[] | undefined;
            let repositoryNameFilter = repositoryName;

            if (repositoryId) {
                requestedRepositoryIds = [String(repositoryId)];
                repositoryNameFilter = undefined;
            } else if (repositoryName) {
                const resolvedRepositoryIds =
                    await this.resolveRepositoryIdsByName({
                        organizationAndTeamData,
                        repositoryName,
                    });

                if (resolvedRepositoryIds?.length) {
                    requestedRepositoryIds = resolvedRepositoryIds;
                    repositoryNameFilter = undefined;
                }
            }

            let allowedRepositoryIds = requestedRepositoryIds;

            if (assignedRepositoryIds !== null) {
                if (allowedRepositoryIds?.length) {
                    allowedRepositoryIds = allowedRepositoryIds.filter((id) =>
                        assignedRepositoryIds.includes(id),
                    );

                    if (allowedRepositoryIds.length === 0) {
                        return this.buildEmptyResponse(limit, page);
                    }
                } else {
                    allowedRepositoryIds = assignedRepositoryIds;
                }
            }

            const enrichedPullRequests: EnrichedPullRequestResponse[] = [];
            const initialSkip = (page - 1) * limit;
            let accumulatedExecutions = 0;
            let totalExecutions = 0;
            let hasMoreExecutions = true;
            const authorPolicyConfig = await this.getCompiledAuthorPolicyConfig(
                authorPolicy,
                organizationAndTeamData,
            );

            // If filtering by title, fetch PR numbers from MongoDB first
            let prFilters:
                | Array<{ number: number; repositoryId: string }>
                | undefined;
            if (pullRequestTitle) {
                const prNumbers =
                    await this.pullRequestsService.findPRNumbersByTitleAndOrganization(
                        pullRequestTitle,
                        organizationId,
                        allowedRepositoryIds,
                    );

                if (prNumbers.length === 0) {
                    // No PRs match the title filter
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

                prFilters = prNumbers;
            }

            while (enrichedPullRequests.length < limit && hasMoreExecutions) {
                const { data: executionsBatch, total } =
                    await this.automationExecutionService.findPullRequestExecutionsByOrganizationAndTeam(
                        {
                            organizationAndTeamData: {
                                organizationId,
                                teamId,
                            },
                            repositoryIds: allowedRepositoryIds,
                            repositoryName: repositoryNameFilter,
                            pullRequestNumber,
                            prFilters,
                            skip: initialSkip + accumulatedExecutions,
                            take: limit,
                            order: 'DESC',
                            includeTotal: totalExecutions === 0,
                        },
                    );

                if (totalExecutions === 0) {
                    totalExecutions = total;
                }

                if (!executionsBatch.length) {
                    hasMoreExecutions = false;
                    break;
                }

                // Prepare bulk fetch criteria
                const prCriteria = executionsBatch
                    .filter(
                        (e) =>
                            e.pullRequestNumber != null &&
                            e.repositoryId != null,
                    )
                    .map((e) => ({
                        number: e.pullRequestNumber!,
                        repositoryId: e.repositoryId!,
                    }));

                // PERF: Fetch PR basics first so author-policy filtering can reduce
                // downstream heavy queries (suggestion aggregation + code review logs).
                const pullRequestsList =
                    (await this.pullRequestsService
                        .findManyByNumbersAndRepositoryIds(
                            prCriteria,
                            organizationId,
                        )
                        .catch((error) => {
                            this.logger.error({
                                message: 'Error bulk fetching pull requests',
                                context: GetEnrichedPullRequestsUseCase.name,
                                error,
                                metadata: {
                                    organizationId,
                                },
                            });
                            return [];
                        })) ?? [];

                const allFetchedPrKeys = new Set<string>();
                pullRequestsList.forEach((pr) => {
                    if (pr.repository?.id && pr.number) {
                        allFetchedPrKeys.add(
                            `${pr.repository.id}_${pr.number}`,
                        );
                    }
                });

                let filteredPullRequestsList = pullRequestsList;
                let allowedPrKeys: Set<string> | null = null;

                if (authorPolicyConfig) {
                    filteredPullRequestsList = pullRequestsList.filter((pr) =>
                        shouldIncludeAuthorByPolicy({
                            policy: authorPolicy,
                            authorId: pr?.user?.id,
                            config: authorPolicyConfig,
                        }),
                    );

                    allowedPrKeys = new Set(
                        filteredPullRequestsList
                            .filter((pr) => pr.repository?.id && pr.number)
                            .map((pr) => `${pr.repository.id}_${pr.number}`),
                    );
                }

                if (
                    allowedPrKeys &&
                    allFetchedPrKeys.size > 0 &&
                    allowedPrKeys.size === 0
                ) {
                    accumulatedExecutions += executionsBatch.length;

                    if (
                        initialSkip + accumulatedExecutions >=
                        totalExecutions
                    ) {
                        hasMoreExecutions = false;
                    }

                    continue;
                }

                const filteredPrCriteria = allowedPrKeys
                    ? prCriteria.filter((criteria) =>
                          allowedPrKeys.has(
                              `${criteria.repositoryId}_${criteria.number}`,
                          ),
                      )
                    : prCriteria;

                const filteredExecutionUuids = allowedPrKeys
                    ? executionsBatch
                          .filter(
                              (execution) =>
                                  execution.pullRequestNumber != null &&
                                  execution.repositoryId != null &&
                                  allowedPrKeys.has(
                                      `${execution.repositoryId}_${execution.pullRequestNumber}`,
                                  ),
                          )
                          .map((execution) => execution.uuid)
                    : executionsBatch.map((execution) => execution.uuid);

                // PERF: Fetch counts and timeline only for PRs that passed author policy.
                const [suggestionCountsMap, codeReviewsList] =
                    await Promise.all([
                        this.pullRequestsService
                            .findSuggestionCountsByNumbersAndRepositoryIds(
                                filteredPrCriteria,
                                organizationId,
                            )
                            .catch((error) => {
                                this.logger.error({
                                    message: 'Error fetching suggestion counts',
                                    context:
                                        GetEnrichedPullRequestsUseCase.name,
                                    error,
                                    metadata: {
                                        organizationId,
                                    },
                                });
                                return new Map<
                                    string,
                                    { sent: number; filtered: number }
                                >();
                            }),
                        this.codeReviewExecutionService
                            .findManyByAutomationExecutionIds(
                                filteredExecutionUuids,
                                // No visibility filter — return all entries (primary + secondary).
                                // Frontend handles visibility filtering client-side via "Show Debug" toggle.
                            )
                            .catch((error) => {
                                this.logger.error({
                                    message: 'Error bulk fetching code reviews',
                                    context:
                                        GetEnrichedPullRequestsUseCase.name,
                                    error,
                                    metadata: {
                                        organizationId,
                                    },
                                });
                                return [];
                            }),
                    ]);

                // Map results for O(1) access
                const prMap = new Map<string, IPullRequests>();
                filteredPullRequestsList.forEach((pr) => {
                    if (pr.repository?.id && pr.number) {
                        prMap.set(`${pr.repository.id}_${pr.number}`, pr);
                    }
                });

                const codeReviewMap = new Map<string, any[]>();
                codeReviewsList.forEach((cr) => {
                    const execId = (cr.automationExecution as any)?.uuid;
                    if (execId) {
                        if (!codeReviewMap.has(execId)) {
                            codeReviewMap.set(execId, []);
                        }
                        codeReviewMap.get(execId).push(cr);
                    }
                });

                // Process executions
                for (let i = 0; i < executionsBatch.length; i++) {
                    const execution = executionsBatch[i];

                    const prKey = `${execution.repositoryId}_${execution.pullRequestNumber}`;
                    const wasFetchedFromMongo = allFetchedPrKeys.has(prKey);
                    if (
                        authorPolicyConfig &&
                        wasFetchedFromMongo &&
                        allowedPrKeys &&
                        !allowedPrKeys.has(prKey)
                    ) {
                        continue;
                    }

                    const pullRequest = prMap.get(prKey);
                    const codeReviewExecutions =
                        codeReviewMap.get(execution.uuid) || [];

                    try {
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

                        // Repository name and code review filters moved to Postgres query

                        const codeReviewTimeline = codeReviewExecutions.map(
                            (cre) => ({
                                uuid: cre.uuid,
                                createdAt: cre.createdAt,
                                updatedAt: cre.updatedAt,
                                status: cre.status,
                                stageName: cre.stageName,
                                stageLabel:
                                    (cre as any)?.metadata?.label ||
                                    cre.stageName,
                                message: cre.message,
                                metadata: cre.metadata,
                                finishedAt: cre.finishedAt,
                            }),
                        );

                        const enrichedData = this.extractEnrichedData(
                            execution.dataExecution,
                        );
                        const commitInfo = this.buildCommitInfo(
                            pullRequest,
                            execution,
                        );

                        // PERF: Use pre-computed counts from aggregation query
                        // Falls back to in-memory computation if aggregation failed
                        const suggestionsCount =
                            suggestionCountsMap.get(prKey) ||
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
                            reviewedCommitSha: commitInfo.reviewedCommitSha,
                            reviewedCommitUrl: commitInfo.reviewedCommitUrl,
                            compareUrl: commitInfo.compareUrl,
                            executionId: execution.uuid,
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
                            // Adaptive-fit fidelity warnings (small
                            // context window forced a degraded path).
                            // Persisted by automationCodeReview's
                            // _buildExecutionData; undefined for
                            // full-fidelity runs.
                            reviewWarnings:
                                execution.dataExecution?.reviewWarnings,
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
                                organizationId,
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
                metadata: { repositoryId, repositoryName, organizationId },
            });
            throw error;
        }
    }

    private buildEmptyResponse(
        limit: number,
        page: number,
    ): PaginatedEnrichedPullRequestsResponse {
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

    private async getCompiledAuthorPolicyConfig(
        policy: PullRequestAuthorPolicy,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        if (policy === 'all') {
            return null;
        }

        try {
            const config = await this.organizationParametersService.findByKey(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                organizationAndTeamData,
            );

            const configValue =
                (config?.configValue as OrganizationParametersAutoAssignConfig) ||
                null;

            return compileAuthorPolicyConfig(configValue);
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to resolve author policy config, defaulting to no author exclusions',
                context: GetEnrichedPullRequestsUseCase.name,
                error,
                metadata: {
                    policy,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            return compileAuthorPolicyConfig(null);
        }
    }

    private async resolveRepositoryIdsByName(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryName: string;
    }): Promise<string[] | undefined> {
        const { organizationAndTeamData, repositoryName } = params;

        if (!repositoryName?.trim()) {
            return undefined;
        }

        const repositories =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

        if (!repositories?.length) {
            return undefined;
        }

        const rawName = repositoryName.trim();
        const normalizedName = rawName.toLowerCase();

        const matchedRepositoryIds = repositories
            .filter((repo) => {
                if (String(repo.id) === rawName) {
                    return true;
                }

                const candidates = [
                    repo.name,
                    (repo as { fullName?: string }).fullName,
                    (repo as { full_name?: string }).full_name,
                    repo.organizationName
                        ? `${repo.organizationName}/${repo.name}`
                        : undefined,
                ].filter(Boolean) as string[];

                return candidates.some(
                    (candidate) => candidate.toLowerCase() === normalizedName,
                );
            })
            .map((repo) => String(repo.id));

        if (matchedRepositoryIds.length === 0) {
            return undefined;
        }

        return Array.from(new Set(matchedRepositoryIds));
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

    private buildCommitInfo(
        pullRequest: IPullRequests,
        execution: any,
    ): {
        reviewedCommitSha?: string;
        reviewedCommitUrl?: string;
        compareUrl?: string;
    } {
        const lastAnalyzedCommit = execution?.dataExecution?.lastAnalyzedCommit;
        const reviewedCommitSha =
            typeof lastAnalyzedCommit === 'string'
                ? lastAnalyzedCommit
                : lastAnalyzedCommit?.sha ||
                  lastAnalyzedCommit?.commitSha ||
                  pullRequest?.commits?.[pullRequest.commits.length - 1]?.sha;

        const repoUrl = pullRequest?.repository?.url;
        const provider = pullRequest?.provider;
        const reviewedCommitUrl = reviewedCommitSha
            ? this.buildCommitUrl(provider, repoUrl, reviewedCommitSha)
            : undefined;

        const baseRef = pullRequest?.baseBranchRef;
        const headRef = pullRequest?.headBranchRef;
        const compareUrl =
            repoUrl && baseRef && headRef
                ? this.buildCompareUrl(provider, repoUrl, baseRef, headRef)
                : undefined;

        return { reviewedCommitSha, reviewedCommitUrl, compareUrl };
    }

    private buildCommitUrl(
        provider: string,
        repoUrl: string | undefined,
        sha: string,
    ) {
        if (!repoUrl) return undefined;

        switch ((provider || '').toLowerCase()) {
            case 'gitlab':
                return `${repoUrl}/-/commit/${sha}`;
            case 'bitbucket':
                return `${repoUrl}/commits/${sha}`;
            case 'azure':
            case 'azuredevops':
                return `${repoUrl}/commit/${sha}`;
            case 'github':
            default:
                return `${repoUrl}/commit/${sha}`;
        }
    }

    private buildCompareUrl(
        provider: string,
        repoUrl: string,
        baseRef: string,
        headRef: string,
    ) {
        switch ((provider || '').toLowerCase()) {
            case 'gitlab':
                return `${repoUrl}/-/compare/${baseRef}...${headRef}`;
            case 'bitbucket':
                return `${repoUrl}/branches/compare/${headRef}%0D${baseRef}`;
            case 'azure':
            case 'azuredevops':
                return `${repoUrl}/compare?base=${baseRef}&target=${headRef}`;
            case 'github':
            default:
                return `${repoUrl}/compare/${baseRef}...${headRef}`;
        }
    }

    private extractSuggestionsCount(pullRequest: IPullRequests): {
        sent: number;
        filtered: number;
    } {
        // Optimized: check if we have pre-computed counts
        if ((pullRequest as any).suggestionsCount) {
            const precomputed = (pullRequest as any).suggestionsCount;
            return {
                sent: precomputed.sent ?? 0,
                filtered: precomputed.filtered ?? 0,
            };
        }

        // Fallback: compute from files (slower)
        let sent = 0;
        let filtered = 0;

        const files = pullRequest.files;
        if (!files || files.length === 0) {
            return { sent: 0, filtered: 0 };
        }

        for (let i = 0; i < files.length; i++) {
            const suggestions = files[i].suggestions;
            if (!suggestions) continue;

            for (let j = 0; j < suggestions.length; j++) {
                const status = suggestions[j].deliveryStatus;
                if (status === DeliveryStatus.SENT) {
                    sent++;
                } else if (status === DeliveryStatus.NOT_SENT) {
                    filtered++;
                }
            }
        }

        return { sent, filtered };
    }
}
