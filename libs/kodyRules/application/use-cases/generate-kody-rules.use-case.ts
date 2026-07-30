import { createLogger } from '@libs/core/log/logger';
import {
    Inject,
    Injectable,
    ServiceUnavailableException,
    UnprocessableEntityException,
    forwardRef,
} from '@nestjs/common';
import pLimit from 'p-limit';

import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { requiresKnowledgeApproval } from '@libs/common/utils/kody-rules/knowledge-approval';
import { with429Retry } from '@libs/core/infrastructure/http/rate-limit-retry';
import { GenerateKodyRulesDTO } from '@libs/core/domain/dtos/generate-kody-rules.dto';

import {
    CommentAnalysisService,
    KodyRulesModelSelection,
} from '@libs/code-review/infrastructure/adapters/services/commentAnalysis.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { resolveKodyRulesModelPolicy } from '@libs/kodyRules/application/services/kody-rules-model-policy';
import { generateDateFilter } from '@libs/common/utils/transforms/date';
import { deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
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
    KodyRulesOrigin,
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
        @Inject(forwardRef(() => CODE_BASE_CONFIG_SERVICE_TOKEN))
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly permissionValidationService: PermissionValidationService,
    ) {}

    /**
     * Whether past-review-generated rules for this repo should land pending
     * (awaiting approval) per the unified knowledge-approval policy. Defaults
     * to active (false) when the config can't be resolved.
     */
    private async requiresPastReviewApproval(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<boolean> {
        try {
            const mergedConfig =
                await this.codeBaseConfigService.getSimpleConfig(
                    organizationAndTeamData,
                    { repositoryId },
                );
            return requiresKnowledgeApproval(
                mergedConfig.kodyKnowledgeApproval,
                KodyRulesOrigin.PAST_REVIEWS,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not resolve kodyKnowledgeApproval for generated rules; defaulting to active',
                context: GenerateKodyRulesUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationAndTeamData, repositoryId },
            });
            return false;
        }
    }

    async execute(body: GenerateKodyRulesDTO, organizationId: string) {
        let platformConfig: ParametersEntity<ParametersKey.PLATFORM_CONFIGS>;
        let organizationAndTeamData: OrganizationAndTeamData;

        try {
            const { teamId, months, weeks, days, repositoriesIds = [] } = body;

            organizationAndTeamData = {
                organizationId,
                teamId,
            };

            // Resolve the model policy up front. Outside the trial, an org
            // without BYOK generates nothing — skip before any expensive PR
            // fetching or status transition, and leave kodyLearningStatus as-is
            // (ENABLED) so the UI shows the feature idle rather than stuck.
            const modelPolicy = await resolveKodyRulesModelPolicy(
                this.permissionValidationService,
                organizationAndTeamData,
            );

            if (!modelPolicy.generate) {
                this.logger.warn({
                    message: `Skipping Kody Rules generation — ${modelPolicy.skipReason}`,
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });
                return [];
            }

            const modelConfig: KodyRulesModelSelection = {
                byokConfig: modelPolicy.byokConfig,
                modelOverride: modelPolicy.modelOverride,
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
            // Repos that received ≥1 persisted rule — promoted to isSelected:true
            // after the loop so the generated rules are visible in the UI.
            const reposWithRules = new Map<string, Repositories>();
            // Repos whose PR fetch errored (auth/integration/rate-limit) rather
            // than genuinely having no PRs. `getPullRequestsByRepository`
            // returns null on failure and [] when the repo has no PRs in the
            // window — collapsing them turned a broken GitHub integration into
            // a misleading "200, 0 rules".
            const failedRepositories: string[] = [];

            // Per-repo denylist of git reviewers to exclude from learning
            // (issue #1497), resolved once from the code-review config.
            const excludedReviewers =
                await this.resolveExcludedReviewersByRepo(
                    organizationAndTeamData,
                );

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

                // null/undefined = fetch failed (e.g. GitHub App install
                // returning 404 on the access token); an empty array is a
                // legitimate "no PRs in this window".
                if (pullRequests == null) {
                    this.logger.error({
                        message:
                            'Failed to fetch pull requests (code management integration/auth error)',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            dateFilter,
                            repositoryId: repository?.id ?? 'repository not found',
                        },
                    });
                    failedRepositories.push(repository?.id ?? 'unknown');
                    continue;
                }

                if (pullRequests.length === 0) {
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

                const excludedForRepo = excludedReviewers.forRepo(
                    repository.id,
                );

                if (excludedForRepo && excludedForRepo.size > 0) {
                    this.logger.log({
                        message: `Excluding ${excludedForRepo.size} reviewer(s) from Kody Rules learning`,
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            organizationAndTeamData,
                            repositoryId: repository.id,
                            excludedCount: excludedForRepo.size,
                        },
                    });
                }

                const processedComments =
                    this.commentAnalysisService.processComments(
                        comments,
                        excludedForRepo,
                    );

                if (!processedComments || processedComments.length === 0) {
                    continue;
                }

                const rules =
                    await this.commentAnalysisService.generateKodyRules({
                        comments: processedComments,
                        existingRules,
                        organizationAndTeamData,
                        modelConfig,
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

                // Pending vs active is the unified approval policy's call, per
                // repo. Default (no approval configured) → active, matching the
                // historical force-activate; with approval on, rules land in
                // the Pending area for review.
                const targetStatus = (await this.requiresPastReviewApproval(
                    organizationAndTeamData,
                    repository.id,
                ))
                    ? KodyRulesStatus.PENDING
                    : KodyRulesStatus.ACTIVE;

                let persistedForRepo = 0;
                for (const rule of rules) {
                    const dto: CreateKodyRuleDto = {
                        type: KodyRulesType.STANDARD,
                        examples: rule.examples,
                        origin: KodyRulesOrigin.PAST_REVIEWS,
                        rule: rule.rule,
                        title: rule.title,
                        repositoryId: repository.id,
                        path: '',
                        status: targetStatus,
                        severity: rule.severity as KodyRuleSeverity,
                    };

                    const userInfo = {
                        userId: 'kody-system-rules-generator',
                        userEmail: 'kody@kodus.io',
                    };

                    // A single rule failing to persist (e.g. a plan cap or a
                    // transient write error) must not discard the rules already
                    // saved for this repo or the remaining repos. Log and move on.
                    try {
                        const createOrUpdateUseCase =
                            await this.moduleRef.resolve(
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

                        persistedForRepo++;

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
                    } catch (persistError) {
                        this.logger.error({
                            message:
                                'Failed to persist a generated Kody rule; keeping the others',
                            context: GenerateKodyRulesUseCase.name,
                            error:
                                persistError instanceof Error
                                    ? persistError
                                    : new Error(String(persistError)),
                            metadata: {
                                repositoryId: repository.id,
                                title: rule.title,
                            },
                        });
                    }
                }

                if (persistedForRepo > 0) {
                    reposWithRules.set(repository.id, {
                        id: repository.id,
                        name: repository.name,
                    } as Repositories);
                }

                allRules.push(rules);
            }

            // If every worked repo failed to even fetch PRs and nothing was
            // generated, this is an integration/auth failure — not "no rules to
            // learn". Throw so the run surfaces a non-2xx (the outer catch
            // resets kodyLearningStatus to ENABLED) instead of a misleading
            // "200, 0 rules". Partial success (some repos produced rules) still
            // completes; the failures are already logged above.
            if (failedRepositories.length > 0 && allRules.length === 0) {
                throw new ServiceUnavailableException(
                    'Could not fetch pull requests from the code management integration; no rules were generated',
                );
            }

            // Make the generated rules visible: every repo that received a rule
            // must have its own code_review_config entry with isSelected:true
            // (the front only lists rules for repos with an individual config).
            // One-way — never demotes a repo the user already selected.
            if (reposWithRules.size > 0) {
                await this.promoteRepositoriesToSelected(
                    organizationAndTeamData,
                    [...reposWithRules.values()],
                );
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
                        this.codeManagementService.getPullRequestReviewComment({
                            organizationAndTeamData,
                            filters: {
                                repository,
                                pullRequestNumber: prNumber,
                            },
                        }),
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

    /**
     * Resolve, once per run, each repo's denylist of git reviewers to exclude
     * from past-review learning (issue #1497). Reads the code-review config and
     * merges global ⊕ repo levels (repo overrides global, matching every other
     * config field). Returns a `forRepo(id)` lookup that yields a `Set` of
     * excluded ids, or `undefined` when the repo excludes no one (so
     * `processComments` skips the filter entirely).
     */
    private async resolveExcludedReviewersByRepo(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{ forRepo: (repositoryId: string) => Set<string> | undefined }> {
        const toSet = (ids?: string[]): Set<string> | undefined => {
            if (!ids || ids.length === 0) {
                return undefined;
            }
            return new Set(ids.map((id) => String(id)));
        };

        try {
            const codeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            const resolvedGlobal = deepMerge(
                getDefaultKodusConfigFile(),
                codeReviewConfig?.configValue?.configs ?? {},
            );
            const globalExcluded = (resolvedGlobal as any)
                ?.kodyLearningExcludedReviewers as string[] | undefined;

            const byRepo = new Map<string, string[] | undefined>();
            for (const repo of codeReviewConfig?.configValue?.repositories ??
                []) {
                const resolvedRepo = deepMerge(
                    resolvedGlobal,
                    repo.configs ?? {},
                );
                byRepo.set(
                    repo.id,
                    (resolvedRepo as any)?.kodyLearningExcludedReviewers as
                        | string[]
                        | undefined,
                );
            }

            return {
                forRepo: (repositoryId: string) =>
                    toSet(
                        byRepo.has(repositoryId)
                            ? byRepo.get(repositoryId)
                            : globalExcluded,
                    ),
            };
        } catch (error) {
            // Never let reviewer resolution break generation — fall back to
            // learning from everyone.
            this.logger.warn({
                message:
                    'Failed to resolve excluded reviewers; learning from all reviewers',
                context: GenerateKodyRulesUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationAndTeamData },
            });
            return { forRepo: () => undefined };
        }
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

        const selected = (
            codeReviewConfig.configValue.repositories ?? []
        ).filter((repo) => repo.isSelected === true);

        if (selected.length > 0) {
            return selected;
        }

        // Config exists but nothing is selected — the normal state right after
        // onboarding (per-repo configs are only created on demand). Fall back to
        // the integration's repositories, same as when no config exists at all.
        this.logger.log({
            message:
                'No repositories selected in code_review_config; falling back to integration repositories',
            context: GenerateKodyRulesUseCase.name,
            metadata: { organizationAndTeamData },
        });
        return this.getRepositoriesIntegration(organizationAndTeamData);
    }

    /**
     * Promote each given repository to `isSelected: true` in code_review_config,
     * creating the entry when it doesn't exist yet. One-way by design: a repo
     * that is already selected (or absent from `repositories`) is never demoted
     * or otherwise touched — rule generation must never unselect a repo.
     */
    private async promoteRepositoriesToSelected(
        organizationAndTeamData: OrganizationAndTeamData,
        repositories: Array<Pick<Repositories, 'id' | 'name'>>,
    ): Promise<void> {
        try {
            const codeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!codeReviewConfig || !codeReviewConfig.configValue) {
                // Provisioning the global config is owned by the sibling fix
                // (code_review_config creation); there's nothing to promote onto.
                this.logger.warn({
                    message:
                        'code_review_config missing; cannot promote repositories to isSelected',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryIds: repositories.map((r) => r.id),
                    },
                });
                return;
            }

            const configValue = codeReviewConfig.configValue;
            const entries: RepositoryCodeReviewConfig[] = Array.isArray(
                configValue.repositories,
            )
                ? [...configValue.repositories]
                : [];
            const byId = new Map(entries.map((r) => [r.id, r]));

            let changed = false;
            for (const repo of repositories) {
                const current = byId.get(repo.id);
                if (!current) {
                    entries.push({
                        id: repo.id,
                        name: repo.name,
                        isSelected: true,
                        configs: {},
                        directories: [],
                    });
                    changed = true;
                } else if (current.isSelected !== true) {
                    current.isSelected = true;
                    changed = true;
                }
                // Already selected → left untouched (never demoted).
            }

            if (!changed) {
                return;
            }

            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                { ...configValue, repositories: entries },
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to promote repositories to isSelected after rule generation',
                context: GenerateKodyRulesUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationAndTeamData },
            });
        }
    }

    private async getRepositoriesIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        if (!integration) {
            // Semantic 422 instead of the generic 500 that surfaced downstream
            // as "Repository service for type 'null' not found" when the team
            // has no code-management integration wired up.
            throw new UnprocessableEntityException(
                'Code management integration not configured for this team',
            );
        }

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration?.uuid },
            team: { uuid: organizationAndTeamData.teamId },
            configKey: IntegrationConfigKey.REPOSITORIES,
        });

        if (!integrationConfig) {
            throw new UnprocessableEntityException(
                'Code management integration has no repositories configured for this team',
            );
        }

        return integrationConfig.configValue as Repositories[];
    }
}
