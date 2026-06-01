import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import pLimit from 'p-limit';

import { with429Retry } from '@libs/core/infrastructure/http/rate-limit-retry';
import { GenerateKodyRulesDTO } from '@libs/core/domain/dtos/generate-kody-rules.dto';

import { CommentAnalysisService } from '@libs/code-review/infrastructure/adapters/services/commentAnalysis.service';
import { generateDateFilter } from '@libs/common/utils/transforms/date';
import { IntegrationConfigKey, ParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { KodyLearningStatus } from '@libs/organization/domain/parameters/types/configValue.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { ModuleRef } from '@nestjs/core';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import { SendRulesNotificationUseCase } from './send-rules-notification.use-case';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { RepositoryCodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';

/**
 * How many pull requests to fetch comments/reviews/files for in parallel.
 * Each PR fans out into 3 provider API calls, so real outbound concurrency
 * peaks at PR_FETCH_CONCURRENCY × 3 — kept modest so slower providers
 * (Bitbucket Cloud) aren't hammered.
 */
// Each PR triggers 3 parallel provider calls inside
// fetchSinglePullRequestComments (allSettled of getAllComments,
// getReviewComments, getFiles). Peak in-flight requests = this value × 3.
//
// 2026-05-23 incident: with concurrency=5 the peak fan-out was 15
// simultaneous Bitbucket Cloud calls, and finishOnboarding 500'd because
// Atlassian Edge returned 429 ("x-envoy-ratelimited: true") on a fresh
// onboarding into kodustech/tiny-url (38+ historical PRs). Cut to 2 so
// peak fan-out is 6 — still fast enough on github/gitlab while staying
// under the unpublished per-endpoint burst limit on bitbucket. Net cost
// on a 30-PR repo with ~300ms per call: ~22s sequential-feel vs the
// original ~9s — acceptable for an onboarding step that runs once and
// is already detached via setImmediate for the background path.
export const PR_FETCH_CONCURRENCY = 2;

@Injectable()
export class GenerateKodyRulesUseCase {
    private readonly logger = createLogger(GenerateKodyRulesUseCase.name);
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly codeManagementService: CodeManagementService,
        private readonly commentAnalysisService: CommentAnalysisService,
        private readonly moduleRef: ModuleRef,
        private readonly sendRulesNotificationUseCase: SendRulesNotificationUseCase,
    ) {}

    async execute(body: GenerateKodyRulesDTO, organizationId: string) {
        let platformConfig: ParametersEntity<ParametersKey.PLATFORM_CONFIGS>;
        let organizationAndTeamData: OrganizationAndTeamData;

        try {
            const { teamId, months, weeks, days, repositoriesIds = [] } = body;

            organizationAndTeamData = {
                organizationId,
                teamId,
            };

            const dateFilter = generateDateFilter({ months, weeks, days });

            const repositories = await this.getRepositories(
                organizationAndTeamData,
            );

            if (!repositories || repositories.length === 0) {
                this.logger.log({
                    message: 'No repositories found',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });
                return [];
            }

            const filteredRepositories =
                repositoriesIds.length > 0
                    ? repositories.filter((repo) =>
                          repositoriesIds.includes(repo.id),
                      )
                    : repositories;

            if (!filteredRepositories || filteredRepositories.length === 0) {
                this.logger.log({
                    message: 'No repositories found after filtering',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });
                return [];
            }

            const findRulesUseCase = await this.moduleRef.resolve(
                FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
                undefined,
                { strict: false },
            );

            const existingRules = await findRulesUseCase.execute(
                organizationId,
                {},
            );

            platformConfig = await this.parametersService.findByKey(
                ParametersKey.PLATFORM_CONFIGS,
                organizationAndTeamData,
            );

            if (!platformConfig || !platformConfig.configValue) {
                throw new Error('Platform config not found');
            }

            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    kodyLearningStatus: KodyLearningStatus.GENERATING_RULES,
                    // Bumped here, reset to 0 on completion below. A hard
                    // crash leaves it incremented — the KodyLearning cron
                    // reads it to stop retrying a run that keeps dying.
                    kodyLearningStuckRetries:
                        (platformConfig.configValue.kodyLearningStuckRetries ??
                            0) + 1,
                },
                organizationAndTeamData,
            );

            const allRules = [];
            const createdRules = []; // To track created rules for notification

            for (const repository of filteredRepositories) {
                const pullRequests =
                    await this.codeManagementService.getPullRequestsByRepository(
                        {
                            organizationAndTeamData,
                            repository,
                            filters: {
                                ...dateFilter,
                            },
                        },
                    );

                if (!pullRequests || pullRequests.length === 0) {
                    this.logger.log({
                        message: 'No pull requests found',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            dateFilter,
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                const comments = await this.fetchPullRequestComments(
                    repository,
                    pullRequests,
                    organizationAndTeamData,
                );

                if (!comments || comments.length === 0) {
                    this.logger.log({
                        message: 'No comments found',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                const processedComments =
                    this.commentAnalysisService.processComments(comments);

                if (!processedComments || processedComments.length === 0) {
                    continue;
                }

                const rules =
                    await this.commentAnalysisService.generateKodyRules({
                        comments: processedComments,
                        existingRules,
                        organizationAndTeamData,
                    });

                if (!rules || rules.length === 0) {
                    this.logger.log({
                        message: 'No rules generated',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                for (const rule of rules) {
                    const dto: CreateKodyRuleDto = {
                        type: KodyRulesType.STANDARD,
                        examples: rule.examples,
                        origin: rule.origin,
                        rule: rule.rule,
                        title: rule.title,
                        repositoryId: repository.id,
                        path: '',
                        status: KodyRulesStatus.PENDING,
                        severity: rule.severity as KodyRuleSeverity,
                    };

                    const userInfo = {
                        userId: 'kody-system-rules-generator',
                        userEmail: 'kody@kodus.io',
                    };

                    const createOrUpdateUseCase = await this.moduleRef.resolve(
                        CreateOrUpdateKodyRulesUseCase,
                        undefined,
                        { strict: false },
                    );

                    const createdRule = await createOrUpdateUseCase.execute(
                        dto,
                        organizationId,
                        userInfo,
                    );

                    if (!createdRule) {
                        throw new Error(
                            'Failed to persist generated Kody rule',
                        );
                    }

                    // Add rule to notification data
                    createdRules.push({
                        title: rule.title,
                        rule: rule.rule,
                        severity: rule.severity,
                    });

                    this.logger.log({
                        message: 'Rule generated and saved successfully',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: { rule },
                    });
                }

                allRules.push(rules);
            }

            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    kodyLearningStatus: KodyLearningStatus.ENABLED,
                    kodyLearningStuckRetries: 0,
                },
                organizationAndTeamData,
            );

            if (allRules.length === 0) {
                this.logger.log({
                    message: 'No rules generated',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });

                return [];
            }

            this.logger.log({
                message: 'Kody rules generated successfully',
                context: GenerateKodyRulesUseCase.name,
                metadata: { body, organizationAndTeamData },
            });

            // Send email notification if rules were created
            if (createdRules.length > 0) {
                this.logger.log({
                    message: 'Sending email notification for new Kody rules',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: {
                        organizationId,
                        rulesCount: createdRules.length,
                    },
                });

                // Execute notification asynchronously to not block the main flow
                this.sendRulesNotificationUseCase
                    .execute(organizationId, createdRules)
                    .catch((error) => {
                        this.logger.error({
                            message:
                                'Error sending email notification for Kody rules',
                            context: GenerateKodyRulesUseCase.name,
                            error,
                            metadata: {
                                organizationId,
                                rulesCount: createdRules.length,
                            },
                        });
                    });
            }

            return allRules.flat();
        } catch (error) {
            this.logger.error({
                message: 'Error generating kody rules',
                context: GenerateKodyRulesUseCase.name,
                error,
                metadata: body,
            });

            if (platformConfig) {
                await this.createOrUpdateParametersUseCase.execute(
                    ParametersKey.PLATFORM_CONFIGS,
                    {
                        ...platformConfig.configValue,
                        kodyLearningStatus: KodyLearningStatus.ENABLED,
                        kodyLearningStuckRetries: 0,
                    },
                    organizationAndTeamData ?? { teamId: body.teamId },
                );
            }

            throw error;
        }
    }

    /**
     * Fetch comments, review comments and changed files for every pull
     * request in a repository.
     *
     * The three per-PR calls are independent, and PRs are independent of
     * each other, so they fan out instead of running fully sequentially.
     * `p-limit` caps how many PRs are in flight so slower providers
     * (Bitbucket Cloud) aren't hammered, and `Promise.allSettled` keeps a
     * single flaky call from aborting the whole rule-generation run.
     */
    private async fetchPullRequestComments(
        repository: Repositories | RepositoryCodeReviewConfig,
        pullRequests: any[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any[]> {
        const limit = pLimit(PR_FETCH_CONCURRENCY);

        const settled = await Promise.allSettled(
            pullRequests.map((pr) =>
                limit(() =>
                    this.fetchSinglePullRequestComments(
                        repository,
                        pr,
                        organizationAndTeamData,
                    ),
                ),
            ),
        );

        const collected: any[] = [];
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                collected.push(result.value);
            } else {
                this.logger.warn({
                    message:
                        'Failed to collect comments for a pull request; skipping it',
                    context: GenerateKodyRulesUseCase.name,
                    error:
                        result.reason instanceof Error
                            ? result.reason
                            : new Error(String(result.reason)),
                    metadata: { repositoryId: repository?.id },
                });
            }
        }

        return collected;
    }

    private async fetchSinglePullRequestComments(
        repository: Repositories | RepositoryCodeReviewConfig,
        pr: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        const prNumber = pr.pull_number;

        // Wrap each provider call individually so a 429 on one (e.g.
        // Atlassian Edge's per-endpoint burst limit on /pullrequests/X)
        // doesn't doom the whole Promise.allSettled. The bitbucket SDK
        // and @gitbeaker both throw on 429 without honouring Retry-After
        // themselves — `with429Retry` parses the header (or backs off
        // exponentially with jitter) and re-runs the single failing
        // call up to 4 times. The outer pLimit(PR_FETCH_CONCURRENCY=2)
        // keeps the cross-PR fan-out modest so the burst budget on
        // slower providers (bitbucket) refills between retries.
        const [generalComments, reviewComments, files] =
            await Promise.allSettled([
                with429Retry(
                    () =>
                        this.codeManagementService.getAllCommentsInPullRequest({
                            organizationAndTeamData,
                            repository,
                            prNumber,
                        }),
                    { label: `genRules:getAllComments PR#${prNumber}` },
                ),
                with429Retry(
                    () =>
                        this.codeManagementService.getPullRequestReviewComment(
                            {
                                organizationAndTeamData,
                                filters: {
                                    repository,
                                    pullRequestNumber: prNumber,
                                },
                            },
                        ),
                    { label: `genRules:getReviewComments PR#${prNumber}` },
                ),
                with429Retry(
                    () =>
                        this.codeManagementService.getFilesByPullRequestId({
                            organizationAndTeamData,
                            repository,
                            prNumber,
                        }),
                    { label: `genRules:getFiles PR#${prNumber}` },
                ),
            ]);

        return {
            pr,
            generalComments: this.settledOrEmpty(
                generalComments,
                'comments',
                repository,
                prNumber,
            ),
            reviewComments: this.settledOrEmpty(
                reviewComments,
                'review comments',
                repository,
                prNumber,
            ),
            files: this.settledOrEmpty(files, 'files', repository, prNumber),
        };
    }

    /**
     * Unwrap a settled per-PR fetch: the value on success, or an empty
     * list (plus a warning) on failure — so one bad call degrades that
     * resource instead of failing the PR or the whole run.
     */
    private settledOrEmpty(
        result: PromiseSettledResult<any>,
        resource: string,
        repository: Repositories | RepositoryCodeReviewConfig,
        prNumber: number,
    ): any {
        if (result.status === 'fulfilled') {
            return result.value;
        }

        this.logger.warn({
            message: `Failed to fetch PR ${resource}; continuing without them`,
            context: GenerateKodyRulesUseCase.name,
            error:
                result.reason instanceof Error
                    ? result.reason
                    : new Error(String(result.reason)),
            metadata: { repositoryId: repository?.id, prNumber },
        });

        return [];
    }

    private async getRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        if (!codeReviewConfig || !codeReviewConfig.configValue)
            return this.getRepositoriesIntegration(organizationAndTeamData);

        return codeReviewConfig.configValue.repositories.filter(
            (repo) => repo.isSelected === true,
        );
    }

    private async getRepositoriesIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        if (!integration) {
            throw new Error('Integration not found');
        }

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration?.uuid },
            team: { uuid: organizationAndTeamData.teamId },
            configKey: IntegrationConfigKey.REPOSITORIES,
        });

        if (!integrationConfig) {
            throw new Error('Integration config not found');
        }

        return integrationConfig.configValue as Repositories[];
    }
}
