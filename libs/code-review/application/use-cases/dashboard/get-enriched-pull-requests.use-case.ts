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
import {
    authorMatchesExact,
    isOpenPullRequest,
    isUnresolvedDeliveredSuggestion,
} from './utils/pull-request-metrics';
import {
    IPullRequests,
    SuggestionCountsBySeverity,
} from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
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
            status,
            createdAtFrom,
            createdAtTo,
            severity,
            category,
            needsAttention,
            author,
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
            // Distinct PRs matching the DB-level filters — captured from the same
            // first batch that computes totalExecutions. Surfaced so the header
            // shows an accurate PR count instead of the loaded-window estimate.
            let distinctPrTotal = 0;
            let hasMoreExecutions = true;
            // Keyset cursor for the intra-request loop. The page offset
            // (initialSkip) still positions the first batch, but once the
            // author-policy filter drops a batch this loop used to re-query with
            // `skip: initialSkip + accumulatedExecutions` — an ever-deeper OFFSET
            // that, under aggressive filtering, walked thousands of rows per
            // request (the #1432 slowdown). After the first batch we continue via
            // the last row's (createdAt, uuid) instead — an indexed range scan.
            let loopCursor:
                { createdAt: Date | string; uuid: string } | undefined;
            const authorPolicyConfig = await this.getCompiledAuthorPolicyConfig(
                authorPolicy,
                organizationAndTeamData,
            );

            // If filtering by title, fetch PR numbers from MongoDB first
            let prFilters:
                Array<{ number: number; repositoryId: string }> | undefined;
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
                const {
                    data: executionsBatch,
                    total,
                    distinctPrTotal: batchDistinctPrTotal,
                } = await this.automationExecutionService.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData: {
                            organizationId,
                            teamId,
                        },
                        repositoryIds: allowedRepositoryIds,
                        repositoryName: repositoryNameFilter,
                        pullRequestNumber,
                        prFilters,
                        status,
                        createdAtFrom,
                        createdAtTo,
                        // First batch: page offset. Subsequent batches:
                        // keyset cursor (no OFFSET over-scan).
                        skip: loopCursor ? undefined : initialSkip,
                        cursor: loopCursor,
                        take: limit,
                        order: 'DESC',
                        includeTotal: totalExecutions === 0,
                    },
                );

                if (totalExecutions === 0) {
                    totalExecutions = total;
                    distinctPrTotal = batchDistinctPrTotal ?? 0;
                }

                if (!executionsBatch.length) {
                    hasMoreExecutions = false;
                    break;
                }

                // Advance the cursor to the last row of this batch (same
                // createdAt DESC, uuid ASC ordering the repository applies) so
                // the next iteration continues right after it.
                const lastBatchRow =
                    executionsBatch[executionsBatch.length - 1];
                loopCursor = {
                    createdAt: lastBatchRow.createdAt,
                    uuid: lastBatchRow.uuid,
                };

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
                                    SuggestionCountsBySeverity
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

                        // Severity filter: keep only PRs that delivered at least
                        // one suggestion of the requested severity. Applied
                        // post-aggregation like hasSentSuggestions (same caveat:
                        // does not adjust totalItems, which counts executions).
                        if (
                            severity &&
                            !(
                                (suggestionsCount?.bySeverity?.[severity] ??
                                    0) > 0
                            )
                        ) {
                            continue;
                        }

                        // Category filter: keep only PRs with a delivered
                        // suggestion of the requested category (same post-query
                        // caveat as severity re: totalItems).
                        if (
                            category &&
                            !(
                                suggestionsCount as {
                                    categories?: string[];
                                }
                            )?.categories?.includes(category)
                        ) {
                            continue;
                        }

                        // Needs-attention filter: an OPEN PR that still carries a
                        // delivered suggestion the author hasn't applied
                        // (implementationStatus ≠ implemented). Mirrors the card
                        // count (countDeliveredPullRequests unresolvedOnly +
                        // openOnly) so the list you see on click can't disagree
                        // with the badge — the old "delivered crit/high" filter
                        // counted a different (and merged/resolved-inclusive) set.
                        if (needsAttention) {
                            if (
                                !isOpenPullRequest(pullRequest) ||
                                !((suggestionsCount?.unresolved ?? 0) > 0)
                            ) {
                                continue;
                            }
                        }

                        // Author filter: "me" (current user) or a free-text name
                        // search matched against the PR author's git identity.
                        if (
                            author &&
                            !this.matchesAuthorFilter(author, pullRequest)
                        ) {
                            continue;
                        }

                        const enrichedPR: EnrichedPullRequestResponse = {
                            prId: pullRequest.uuid!,
                            prNumber: pullRequest.number,
                            title: pullRequest.title,
                            status: pullRequest.status,
                            merged: pullRequest.merged,
                            heavy: pullRequest.heavy,
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
                distinctPrTotal,
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

    // Author filter. `author === 'me'` resolves to the logged-in user (matched
    // by email against the PR author's git identity). Any other value is an
    // EXACT author identity picked from the autocomplete — it must equal the PR
    // author's display name, username, or email (case-insensitive).
    private matchesAuthorFilter(
        author: string,
        pullRequest: IPullRequests,
    ): boolean {
        const prUser = (pullRequest.user || {}) as {
            email?: string;
            username?: string;
            name?: string;
        };

        // `me` → match the logged-in user by email (handled here since only the
        // use-case has the request user). Any other value is the exact author
        // identity selected from the autocomplete (see authorMatchesExact).
        if (author.toLowerCase() === 'me') {
            const email = this.request.user?.email?.toLowerCase();
            const candidates = [prUser.email, prUser.username, prUser.name]
                .filter((v): v is string => Boolean(v))
                .map((v) => v.toLowerCase());
            return Boolean(email) && candidates.includes(email as string);
        }

        return authorMatchesExact(prUser, author);
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

    private extractSuggestionsCount(
        pullRequest: IPullRequests,
    ): SuggestionCountsBySeverity {
        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
        const unresolvedBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
        const categorySet = new Set<string>();
        let sent = 0;
        let filtered = 0;
        let failed = 0;
        let replaced = 0;
        let unresolved = 0;

        // Optimized: check if we have pre-computed counts
        if ((pullRequest as any).suggestionsCount) {
            const precomputed = (pullRequest as any).suggestionsCount;
            return {
                sent: precomputed.sent ?? 0,
                filtered: precomputed.filtered ?? 0,
                failed: precomputed.failed ?? 0,
                replaced: precomputed.replaced ?? 0,
                unresolved: precomputed.unresolved ?? 0,
                unresolvedBySeverity: {
                    critical: precomputed.unresolvedBySeverity?.critical ?? 0,
                    high: precomputed.unresolvedBySeverity?.high ?? 0,
                    medium: precomputed.unresolvedBySeverity?.medium ?? 0,
                    low: precomputed.unresolvedBySeverity?.low ?? 0,
                },
                bySeverity: {
                    critical: precomputed.bySeverity?.critical ?? 0,
                    high: precomputed.bySeverity?.high ?? 0,
                    medium: precomputed.bySeverity?.medium ?? 0,
                    low: precomputed.bySeverity?.low ?? 0,
                },
                categories: Array.isArray(precomputed.categories)
                    ? precomputed.categories
                    : [],
            };
        }

        // Fallback: compute from files (slower)
        const files = pullRequest.files;
        if (!files || files.length === 0) {
            return {
                sent: 0,
                filtered: 0,
                failed: 0,
                replaced: 0,
                unresolved: 0,
                unresolvedBySeverity,
                bySeverity,
                categories: [],
            };
        }

        for (let i = 0; i < files.length; i++) {
            const suggestions = files[i].suggestions;
            if (!suggestions) continue;

            for (let j = 0; j < suggestions.length; j++) {
                const suggestion = suggestions[j];
                const status = suggestion.deliveryStatus;
                if (status === DeliveryStatus.SENT) {
                    sent++;
                    const severity = String(
                        (suggestion as any).severity ?? '',
                    ).toLowerCase();
                    if (severity in bySeverity) {
                        bySeverity[severity as keyof typeof bySeverity]++;
                    }
                    // Unresolved = sent but not implemented (missing status =
                    // unresolved) — shared predicate, mirroring the aggregation +
                    // the card count.
                    if (isUnresolvedDeliveredSuggestion(suggestion)) {
                        unresolved++;
                        if (severity in unresolvedBySeverity) {
                            unresolvedBySeverity[
                                severity as keyof typeof unresolvedBySeverity
                            ]++;
                        }
                    }
                    const label = String(
                        (suggestion as any).label ?? '',
                    ).toLowerCase();
                    if (label) categorySet.add(label);
                } else if (status === DeliveryStatus.NOT_SENT) {
                    filtered++;
                } else if (
                    status === DeliveryStatus.FAILED ||
                    status === DeliveryStatus.FAILED_LINES_MISMATCH
                ) {
                    failed++;
                } else if (status === DeliveryStatus.REPLACED) {
                    replaced++;
                }
            }
        }

        return {
            sent,
            filtered,
            failed,
            replaced,
            unresolved,
            unresolvedBySeverity,
            bySeverity,
            categories: Array.from(categorySet),
        };
    }
}
