import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import pLimit from 'p-limit';

import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@libs/automation/domain/automation/contracts/automation.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    CodeReviewConfig,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    approvalPolicyForPlatform,
    approvalPolicyFromConfig,
    evaluateApproval,
    type ApprovalDecision,
} from '@libs/code-review/domain/approval/approval-decision';
import {
    CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN,
    IConditionalApprovalAccessService,
} from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import {
    formatApprovalReasonComment,
    isApprovalReasonComment,
} from '@libs/code-review/infrastructure/approval/approval-reason-comment';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { runWithBoundedTimeout } from '@libs/core/workflow/infrastructure/run-with-bounded-timeout';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@libs/organization/domain/team/interfaces/team.interface';
import { AzureRepoCommentTypeString } from '@libs/platform/domain/azure/entities/azureRepoExtras.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestWithDeliveredSuggestions } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

const API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED =
    process.env.API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED;

// The pool budget these two numbers spend against is 25, not 50 —
// api.module.ts passes `poolSize: 25` to SharedPostgresModule.forRoot,
// which overrides the factory's env-based default.
//
// Team level is the one that caused the 2026-08-06 incident: the two
// prep rajadas (parameters/findOne, teamAutomation/find) and the main
// teams.map body are pure DB work, one to two queries each, so ~40
// teams meant ~40 simultaneous connections — more than the pool holds.
// Capping at 10 makes those fan-outs map to at most 10 connections and
// leaves 15 for request traffic.
const TEAM_CONCURRENCY = 10;
// PR level is a different animal and must NOT be tuned like the team
// level. Of the five awaits in the per-PR path, exactly one hits the
// database (automationExecutionService.findLatestExecutionByFilters);
// the other four are git-provider HTTP calls (getPullRequest,
// getPullRequestReviewThreads, getPullRequestReviewComments,
// checkIfPullRequestShouldBeApproved). A task parked on an HTTP round
// trip holds no pool connection at all, so throttling here buys almost
// no pool safety and costs wall-clock directly.
//
// This limiter is created once per run, so the value is a GLOBAL cap
// across all teams — and because teamLimit wraps the whole per-team
// body including this loop, a low value here stalls the team slots too:
// at 3, ten team tasks would queue behind three PR slots and the
// effective parallelism of the entire cron collapses to 3. The cron
// runs every 6 minutes and is expected to finish in seconds, so that
// trade is wrong. 15 keeps the git-provider work wide while the DB
// slice of it stays around a fifth of that in practice.
const PR_CONCURRENCY = 15;
const FINAL_PROVIDER_TIMEOUT_MS = 15_000;
const APPROVAL_REASON_LOOKUP_TIMEOUT_MS = 10_000;
const APPROVAL_REASON_WRITE_TIMEOUT_MS = 15_000;
const APPROVAL_FILES_TIMEOUT_MS = 10_000;
const DIRECTORY_FILE_CACHE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class CheckIfPRCanBeApprovedCronProvider {
    private readonly directoryFilesByReviewedHead = new Map<
        string,
        { files: Array<Pick<FileChange, 'filename'>>; fetchedAt: number }
    >();
    private readonly logger = createLogger(
        CheckIfPRCanBeApprovedCronProvider.name,
    );
    private pullRequestMessagesCache = new Map<
        string,
        IPullRequestMessages | null
    >();

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly codeManagementService: CodeManagementService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
        private readonly distributedLockService: DistributedLockService,
        @Inject(CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN)
        private readonly conditionalApprovalAccess: IConditionalApprovalAccessService,
    ) {}

    @Cron(API_CRON_CHECK_IF_PR_SHOULD_BE_APPROVED, {
        name: 'CHECK IF PR SHOULD BE APPROVED',
        timeZone: 'America/Sao_Paulo',
        waitForCompletion: true,
    })
    async handleCron() {
        const lockKey = 'CRON:CHECK_IF_PR_SHOULD_BE_APPROVED';

        let lock: DistributedLock;
        try {
            lock = await this.distributedLockService.acquire(lockKey, {
                ttl: 1000 * 60 * 5, // 5 minutes TTL to prevent stale locks
            });

            if (!lock) {
                this.logger.log({
                    message: 'Cron execution skipped - Lock already acquired',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: { lockKey },
                });
                return;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error acquiring distributed lock for cron execution',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: { lockKey },
                error,
            });
            return;
        }

        // Clear cache at start of each cron run
        this.pullRequestMessagesCache.clear();

        try {
            this.logger.log({
                message: 'Check if PR can be approved cron started',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });

            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            if (!teams || teams.length === 0) {
                this.logger.log({
                    message: 'No teams found',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        timestamp: new Date().toISOString(),
                    },
                });

                return;
            }

            // Fetch automation ONCE (same for all teams)
            const codeReviewAutomation = await this.automationService.find({
                automationType: AutomationType.AUTOMATION_CODE_REVIEW,
            });

            if (!codeReviewAutomation?.[0]) {
                this.logger.error({
                    message: 'Code review automation not found',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                });
                return;
            }

            const automationUuid = codeReviewAutomation[0].uuid;

            // Calculate once outside loop
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const now = new Date();

            // Both limiters are global for the run. teamLimit is the one
            // that bounds real connection usage — the team fan-outs are
            // pure DB. prLimit sits over mostly-HTTP work, so it is set
            // wide on purpose; see the constants above for why the two
            // are not tuned the same way.
            const teamLimit = pLimit(TEAM_CONCURRENCY);
            const prLimit = pLimit(PR_CONCURRENCY);

            // Fetch all parameters in parallel (non-blocking)
            const parametersPromises = teams.map((team) =>
                teamLimit(() =>
                    this.parametersService
                        .findOne({
                            configKey: ParametersKey.CODE_REVIEW_CONFIG,
                            team: { uuid: team.uuid },
                            active: true,
                        })
                        .catch((error) => {
                            this.logger.error({
                                message: 'Error fetching parameter for team',
                                context:
                                    CheckIfPRCanBeApprovedCronProvider.name,
                                metadata: { teamId: team.uuid },
                                error,
                            });
                            return null;
                        }),
                ),
            );

            const allParameters = await Promise.all(parametersPromises);

            // Create lookup map for O(1) access (guaranteed by the returned teamId)
            const parametersByTeam = new Map(
                allParameters
                    .filter((param) => param?.team?.uuid)
                    .map((param) => [param.team.uuid, param]),
            );

            // Fetch all teamAutomations in parallel
            const teamAutomationsPromises = teams.map((team) =>
                teamLimit(() =>
                    this.teamAutomationService
                        .find({
                            team: { uuid: team.uuid },
                            automation: { uuid: automationUuid },
                        })
                        .catch((error) => {
                            this.logger.error({
                                message: 'Error fetching team automation',
                                context:
                                    CheckIfPRCanBeApprovedCronProvider.name,
                                metadata: { teamId: team.uuid },
                                error,
                            });
                            return [];
                        }),
                ),
            );

            const allTeamAutomations = await Promise.all(
                teamAutomationsPromises,
            );

            // Create lookup map using teamId from first automation
            const teamAutomationsByTeam = new Map(
                allTeamAutomations
                    .filter((automations) => automations?.length > 0)
                    .map((automations) => [
                        automations[0].team?.uuid,
                        automations[0],
                    ]),
            );

            // Process teams in parallel (bounded by teamLimit)
            await Promise.allSettled(
                teams.map((team) =>
                    teamLimit(async () => {
                        const organizationId = team.organization?.uuid;
                        const teamId = team.uuid;

                        const organizationAndTeamData: OrganizationAndTeamData =
                            {
                                organizationId,
                                teamId,
                            };

                        const codeReviewParameter =
                            parametersByTeam.get(teamId);

                        if (!codeReviewParameter?.configValue) {
                            return;
                        }

                        const codeReviewConfig =
                            codeReviewParameter?.configValue;

                        if (
                            !codeReviewParameter ||
                            !codeReviewConfig ||
                            !Array.isArray(codeReviewConfig.repositories) ||
                            codeReviewConfig.repositories?.length < 1
                        ) {
                            return;
                        }

                        const teamAutomation =
                            teamAutomationsByTeam.get(teamId);

                        if (!teamAutomation) {
                            return;
                        }

                        const eligiblePullRequestRefs =
                            await this.automationExecutionService.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
                                sevenDaysAgo,
                                now,
                                teamAutomation.uuid,
                            );

                        const eligiblePullRequestKeys = new Set(
                            eligiblePullRequestRefs.map(
                                (ref) =>
                                    `${ref.repositoryId}:${ref.pullRequestNumber}`,
                            ),
                        );

                        const automationExecutionsPRs = [
                            ...new Set(
                                eligiblePullRequestRefs
                                    .map((ref) => ref.pullRequestNumber)
                                    .filter((prNumber): prNumber is number =>
                                        Number.isInteger(prNumber),
                                    ),
                            ),
                        ];

                        if (!automationExecutionsPRs?.length) {
                            return;
                        }

                        const openPullRequestsWithSuggestions =
                            await this.pullRequestService.findPullRequestsWithDeliveredSuggestions(
                                organizationId,
                                automationExecutionsPRs,
                                PullRequestState.OPENED,
                            );
                        // A repository's kodus-config.yml may define the
                        // label scope even when the stored team config does
                        // not. Resolve each candidate before deciding whether
                        // a clean, zero-suggestion PR can be approved.
                        const noSuggestionPrs =
                            (await this.pullRequestService.findPullRequestsWithoutDeliveredSuggestionsForApproval(
                                organizationId,
                                eligiblePullRequestRefs,
                                PullRequestState.OPENED,
                            )) ?? [];
                        const openPullRequests = [
                            ...(openPullRequestsWithSuggestions ?? []),
                            ...noSuggestionPrs,
                        ];

                        this.logger.log({
                            message: 'Open pull requests found',
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            metadata: {
                                openPullRequests: openPullRequests?.length,
                                organizationAndTeamData: {
                                    organizationId,
                                    teamId,
                                },
                            },
                        });

                        if (
                            !openPullRequests ||
                            openPullRequests?.length === 0
                        ) {
                            return;
                        }

                        const eligibleOpenPullRequests =
                            openPullRequests.filter((pr) =>
                                eligiblePullRequestKeys.has(
                                    `${pr?.repository?.id}:${pr?.number}`,
                                ),
                            );

                        if (!eligibleOpenPullRequests.length) {
                            return;
                        }

                        // The resolved config depends only on the repository;
                        // share one resolution across its PRs in this run.
                        const configByRepository = new Map<
                            string,
                            ReturnType<
                                typeof this.codeBaseConfigService.getConfig
                            >
                        >();

                        // Process PRs in parallel (bounded by prLimit)
                        await Promise.allSettled(
                            eligibleOpenPullRequests.map((pr) =>
                                prLimit(async () => {
                                    const repository = pr?.repository;

                                    const codeReviewConfigFromRepo =
                                        codeReviewConfig?.repositories?.find(
                                            (codeReviewConfigRepo) =>
                                                codeReviewConfigRepo?.id ===
                                                repository?.id,
                                        );

                                    if (!codeReviewConfigFromRepo) {
                                        return;
                                    }

                                    let resolvedConfig:
                                        CodeReviewConfig | undefined;
                                    if (
                                        codeReviewConfigFromRepo.directories
                                            ?.length
                                    ) {
                                        const execution =
                                            await this.automationExecutionService.findLatestExecutionByFilters(
                                                {
                                                    status: AutomationStatus.SUCCESS,
                                                    teamAutomation: {
                                                        uuid: teamAutomation.uuid,
                                                    },
                                                    pullRequestNumber:
                                                        pr.number,
                                                    repositoryId: repository.id,
                                                },
                                            );
                                        const reviewedHead =
                                            this.getLastAnalyzedCommitSha(
                                                execution?.dataExecution
                                                    ?.lastAnalyzedCommit,
                                            );
                                        const cacheKey = reviewedHead
                                            ? `${organizationId}:${repository.id}:${pr.number}:${reviewedHead}`
                                            : null;
                                        const cached = cacheKey
                                            ? this.directoryFilesByReviewedHead.get(
                                                  cacheKey,
                                              )
                                            : undefined;
                                        let files =
                                            cached &&
                                            Date.now() - cached.fetchedAt <
                                                DIRECTORY_FILE_CACHE_TTL_MS
                                                ? cached.files
                                                : undefined;
                                        if (!files) {
                                            let liveFiles: Awaited<
                                                ReturnType<
                                                    CodeManagementService['getFilesByPullRequestId']
                                                >
                                            >;
                                            try {
                                                liveFiles =
                                                    await runWithBoundedTimeout(
                                                        this.codeManagementService.getFilesByPullRequestId(
                                                            {
                                                                organizationAndTeamData,
                                                                repository: {
                                                                    id: repository.id,
                                                                    name: repository.name,
                                                                },
                                                                prNumber:
                                                                    pr.number,
                                                                headSha:
                                                                    reviewedHead ??
                                                                    undefined,
                                                            },
                                                            pr.provider as PlatformType,
                                                        ),
                                                        APPROVAL_FILES_TIMEOUT_MS,
                                                        'approval directory files',
                                                    );
                                            } catch (error) {
                                                this.logger.warn({
                                                    message:
                                                        'Could not load PR files for directory approval policy',
                                                    context:
                                                        CheckIfPRCanBeApprovedCronProvider.name,
                                                    error,
                                                    metadata: {
                                                        ...organizationAndTeamData,
                                                        repositoryId:
                                                            repository.id,
                                                        prNumber: pr.number,
                                                        reviewedHead,
                                                        timeoutMs:
                                                            APPROVAL_FILES_TIMEOUT_MS,
                                                    },
                                                });
                                                return;
                                            }
                                            files = liveFiles?.map((file) => ({
                                                filename:
                                                    file.filename ?? file.path,
                                            }));
                                            if (cacheKey && files?.length) {
                                                if (
                                                    this
                                                        .directoryFilesByReviewedHead
                                                        .size >= 1000
                                                ) {
                                                    const oldest =
                                                        this.directoryFilesByReviewedHead
                                                            .keys()
                                                            .next().value;
                                                    if (oldest) {
                                                        this.directoryFilesByReviewedHead.delete(
                                                            oldest,
                                                        );
                                                    }
                                                }
                                                this.directoryFilesByReviewedHead.set(
                                                    cacheKey,
                                                    {
                                                        files,
                                                        fetchedAt: Date.now(),
                                                    },
                                                );
                                            }
                                        }
                                        if (!files?.length) return;
                                        resolvedConfig =
                                            await this.codeBaseConfigService.getConfig(
                                                organizationAndTeamData,
                                                repository,
                                                files as FileChange[],
                                            );
                                    } else {
                                        if (
                                            !configByRepository.has(
                                                codeReviewConfigFromRepo.id,
                                            )
                                        ) {
                                            configByRepository.set(
                                                codeReviewConfigFromRepo.id,
                                                this.codeBaseConfigService.getConfig(
                                                    organizationAndTeamData,
                                                    {
                                                        id: codeReviewConfigFromRepo.id,
                                                        name: codeReviewConfigFromRepo.name,
                                                    },
                                                    [],
                                                ),
                                            );
                                        }
                                        resolvedConfig =
                                            await configByRepository.get(
                                                codeReviewConfigFromRepo.id,
                                            );
                                    }

                                    if (
                                        resolvedConfig?.pullRequestApprovalActive ===
                                        false
                                    ) {
                                        return;
                                    }

                                    await this.shouldApprovePR({
                                        organizationAndTeamData,
                                        pr,
                                        codeReviewConfig: resolvedConfig,
                                        teamAutomationId: teamAutomation.uuid,
                                    });
                                }),
                            ),
                        );
                    }),
                ),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error checking if PR can be approved generator cron',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });
        } finally {
            try {
                await lock.release();
            } catch (error) {
                this.logger.error({
                    message:
                        'Error releasing distributed lock after cron execution',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: { lockKey },
                    error,
                });
            }
        }
    }

    private async shouldApprovePR({
        organizationAndTeamData,
        pr,
        codeReviewConfig,
        teamAutomationId,
    }: {
        organizationAndTeamData: OrganizationAndTeamData;
        pr: IPullRequestWithDeliveredSuggestions;
        codeReviewConfig?: CodeReviewConfig;
        teamAutomationId: string;
    }): Promise<boolean> {
        const repository = pr?.repository;
        const prNumber = pr?.number;
        const platformType = pr?.provider as PlatformType;

        const codeManagementRequestData = {
            organizationAndTeamData,
            repository: {
                id: repository?.id,
                name: repository?.name,
            },
            prNumber: prNumber,
        };

        const configuredPolicy = codeReviewConfig
            ? approvalPolicyFromConfig(codeReviewConfig)
            : undefined;
        if (
            platformType === PlatformType.AZURE_REPOS &&
            configuredPolicy?.labels?.length
        ) {
            return false;
        }
        const policy = configuredPolicy
            ? approvalPolicyForPlatform(configuredPolicy, platformType)
            : undefined;
        const policyActive = !!(
            policy?.labels?.length ||
            policy?.authors?.length ||
            policy?.assessRisk ||
            policy?.sensitivePaths?.length
        );
        // A saved policy must never silently fall back to legacy approval
        // when its beta flag or paid entitlement is no longer available.
        if (
            policyActive &&
            !(await this.conditionalApprovalAccess.isEnabled(
                organizationAndTeamData,
            ))
        ) {
            return false;
        }
        let conditionalDecision: ApprovalDecision | undefined;
        const noSuggestions =
            Array.isArray(pr?.suggestions) && pr.suggestions.length === 0;
        const allowNoComments = !!policy?.labels?.length && noSuggestions;
        if (noSuggestions && !allowNoComments) {
            return false;
        }
        const lastExecution =
            await this.automationExecutionService.findLatestExecutionByFilters({
                status: AutomationStatus.SUCCESS,
                teamAutomation: { uuid: teamAutomationId },
                pullRequestNumber: prNumber,
                repositoryId: repository?.id,
            });
        const lastAnalyzedCommitSha = this.getLastAnalyzedCommitSha(
            lastExecution?.dataExecution?.lastAnalyzedCommit,
        );
        let changedPaths: string[] = [];
        if (
            allowNoComments &&
            !['approve', 'out-of-scope'].includes(
                lastExecution?.dataExecution?.approvalDecision?.kind,
            )
        ) {
            return false;
        }
        let currentPullRequest;

        if (lastAnalyzedCommitSha || policyActive) {
            currentPullRequest =
                await this.codeManagementService.getPullRequest(
                    {
                        organizationAndTeamData,
                        repository: {
                            id: repository?.id,
                            name: repository?.name,
                        },
                        prNumber: prNumber,
                        includeLabels: !!policy?.labels?.length,
                    },
                    platformType,
                );

            const currentHeadSha =
                currentPullRequest?.head?.sha ||
                (currentPullRequest as any)?.headSha ||
                (currentPullRequest as any)?.head?.commit?.sha;

            if (currentHeadSha && currentHeadSha !== lastAnalyzedCommitSha) {
                this.logger.log({
                    message: `Skipping approval for PR#${prNumber} due to new commit since last reviewed commit`,
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        organizationAndTeamData,
                        repository: {
                            id: repository?.id,
                            name: repository?.name,
                        },
                        prNumber,
                        lastAnalyzedCommitSha,
                        currentHeadSha,
                    },
                });

                return false;
            }

            if (policyActive) {
                // A conditional approval must have a saved successful review
                // and a live head. Do not infer either from a missing response.
                if (
                    !lastExecution ||
                    !lastAnalyzedCommitSha ||
                    !currentHeadSha ||
                    (policy?.labels?.length && !currentPullRequest?.labels)
                ) {
                    return false;
                }
                if (policy.sensitivePaths?.length) {
                    let files: Awaited<
                        ReturnType<
                            CodeManagementService['getFilesByPullRequestId']
                        >
                    >;
                    try {
                        files = await runWithBoundedTimeout(
                            this.codeManagementService.getFilesByPullRequestId(
                                {
                                    ...codeManagementRequestData,
                                    headSha: currentHeadSha,
                                },
                                platformType,
                            ),
                            APPROVAL_FILES_TIMEOUT_MS,
                            'approval sensitive paths files',
                        );
                    } catch (error) {
                        this.logger.warn({
                            message:
                                'Could not load PR files for sensitive-path approval policy',
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            error,
                            metadata: {
                                ...organizationAndTeamData,
                                repositoryId: repository?.id,
                                prNumber,
                                reviewedHead: currentHeadSha,
                                timeoutMs: APPROVAL_FILES_TIMEOUT_MS,
                            },
                        });
                        return false;
                    }
                    if (!files) return false;
                    changedPaths = files
                        .map((file) => file.filename ?? file.path)
                        .filter((path): path is string => !!path);
                }
                const decision = evaluateApproval({
                    approvalActive: true,
                    policy,
                    author:
                        currentPullRequest?.user?.login ??
                        currentPullRequest?.user?.username,
                    labels: currentPullRequest?.labels,
                    changedPaths,
                    reviewClean: true,
                    risk: lastExecution.dataExecution?.approvalRisk,
                    currentHeadSha,
                });
                conditionalDecision = decision;
                if (decision.kind !== 'approve') {
                    if (decision.kind === 'hold') {
                        await this.postConditionalApprovalReason(
                            codeManagementRequestData,
                            platformType,
                            decision,
                        );
                    }
                    this.logger.log({
                        message: `Holding cron approval for PR#${prNumber}: ${decision.reason}`,
                        context: CheckIfPRCanBeApprovedCronProvider.name,
                    });
                    return false;
                }
            }
        }

        try {
            let reviewComments: any[];

            if (platformType === PlatformType.GITHUB) {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewThreads(
                        codeManagementRequestData,
                        PlatformType.GITHUB,
                    );
            } else {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewComments(
                        codeManagementRequestData,
                        platformType,
                    );
            }

            this.logger.log({
                message: `Review comments found for PR#${prNumber}`,
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    reviewComments: reviewComments?.length,
                    organizationAndTeamData,
                    prNumber,
                    repository: {
                        name: repository?.name,
                        id: repository?.id,
                    },
                },
            });

            if (platformType === PlatformType.AZURE_REPOS) {
                reviewComments = reviewComments?.filter(
                    (comment) =>
                        comment?.commentType ===
                        AzureRepoCommentTypeString.CODE,
                );
            }

            if (
                (!reviewComments || reviewComments.length < 1) &&
                !allowNoComments
            ) {
                return false;
            }
            reviewComments ??= [];

            if (pr?.suggestions && pr?.suggestions?.length > 0) {
                const deliveredCommentIds = new Set(
                    pr.suggestions
                        .filter((s) => s?.comment?.id)
                        .map((s) => String(s.comment.id)),
                );

                reviewComments = reviewComments.filter((comment) => {
                    let commentId;

                    if (platformType === PlatformType.GITHUB) {
                        commentId = comment?.fullDatabaseId || comment?.id;
                    } else if (platformType === PlatformType.AZURE_REPOS) {
                        commentId = comment?.threadId;
                    } else {
                        commentId = comment?.id;
                    }

                    if (!commentId) {
                        return false;
                    }

                    return deliveredCommentIds.has(String(commentId));
                });

                this.logger.log({
                    message: `Filtered review comments by delivered suggestions for PR#${prNumber}`,
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        totalDeliveredSuggestions: pr?.suggestions?.length,
                        filteredReviewComments: reviewComments.length,
                        organizationAndTeamData,
                        prNumber,
                        repository: {
                            name: repository?.name,
                            id: repository?.id,
                        },
                    },
                });

                if (!reviewComments || reviewComments?.length < 1) {
                    return false;
                }
            }

            const pullRequestMessagesConfig =
                await this.setPullRequestMessagesConfig(
                    repository,
                    organizationAndTeamData,
                    codeReviewConfig,
                );

            if (pullRequestMessagesConfig) {
                const startMessageContent =
                    pullRequestMessagesConfig?.startReviewMessage?.content;
                const endMessageContent =
                    pullRequestMessagesConfig?.endReviewMessage?.content;

                if (startMessageContent || endMessageContent) {
                    reviewComments = reviewComments?.filter((comment) => {
                        if (!comment?.body) {
                            return true;
                        }

                        const isStartMessage =
                            startMessageContent &&
                            comment.body === startMessageContent;
                        const isEndMessage =
                            endMessageContent &&
                            comment.body === endMessageContent;

                        return !isStartMessage && !isEndMessage;
                    });
                }
            }

            if (reviewComments.length < 1 && !allowNoComments) {
                return false;
            }

            const isEveryReviewCommentResolved = reviewComments?.every(
                (reviewComment) => reviewComment?.isResolved,
            );

            if (isEveryReviewCommentResolved) {
                const hasInProgressReview =
                    await this.hasInProgressReviewExecution({
                        teamAutomationId,
                        pullRequestNumber: prNumber,
                        repositoryId: repository?.id,
                    });

                if (hasInProgressReview) {
                    this.logger.log({
                        message:
                            'Skipping approval due to in-progress review execution in final check',
                        context: CheckIfPRCanBeApprovedCronProvider.name,
                        metadata: {
                            organizationAndTeamData,
                            prNumber,
                            repository: {
                                name: repository?.name,
                                id: repository?.id,
                            },
                            teamAutomationId,
                        },
                    });
                    return false;
                }

                this.logger.log({
                    message: `Is every review comment resolved for PR#${prNumber}`,
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        isEveryReviewCommentResolved,
                        organizationAndTeamData,
                        prNumber,
                        repository: {
                            name: repository?.name,
                            id: repository?.id,
                        },
                    },
                });

                if (conditionalDecision) {
                    const before = await runWithBoundedTimeout(
                        this.codeManagementService.getReviewStatusByPullRequest(
                            codeManagementRequestData,
                        ),
                        FINAL_PROVIDER_TIMEOUT_MS,
                        'approval provider-status lookup',
                    );
                    if (before == null) {
                        this.logger.warn({
                            message: 'Approval provider status unavailable',
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            metadata: {
                                organizationAndTeamData,
                                repositoryId: repository?.id,
                                prNumber,
                                timeoutMs: FINAL_PROVIDER_TIMEOUT_MS,
                            },
                        });
                        return false;
                    }
                    if (before === PullRequestReviewState.APPROVED) {
                        // Approval may have succeeded while its reason comment
                        // failed. Retry the idempotent comment on later passes.
                        await this.postConditionalApprovalReason(
                            codeManagementRequestData,
                            platformType,
                            conditionalDecision,
                        );
                        return false;
                    }
                    // Comments and provider status checks can take time. A new
                    // commit or a removed scope label invalidates the decision
                    // made at the start of this cron pass.
                    const latestPullRequest = await runWithBoundedTimeout(
                        this.codeManagementService.getPullRequest(
                            {
                                ...codeManagementRequestData,
                                includeLabels: !!policy?.labels?.length,
                            },
                            platformType,
                        ),
                        FINAL_PROVIDER_TIMEOUT_MS,
                        'approval final PR refresh',
                    );
                    const latestHeadSha =
                        latestPullRequest?.head?.sha ||
                        (latestPullRequest as any)?.headSha ||
                        (latestPullRequest as any)?.head?.commit?.sha;
                    if (
                        !latestHeadSha ||
                        latestHeadSha !== lastAnalyzedCommitSha ||
                        (policy?.labels?.length && !latestPullRequest?.labels)
                    ) {
                        return false;
                    }
                    conditionalDecision = evaluateApproval({
                        approvalActive: true,
                        policy,
                        author: latestPullRequest?.user?.login,
                        labels: latestPullRequest?.labels,
                        changedPaths,
                        reviewClean: true,
                        risk: lastExecution?.dataExecution?.approvalRisk,
                        currentHeadSha: latestHeadSha,
                    });
                    if (conditionalDecision.kind !== 'approve') {
                        if (conditionalDecision.kind === 'hold') {
                            await this.postConditionalApprovalReason(
                                codeManagementRequestData,
                                platformType,
                                conditionalDecision,
                            );
                        }
                        return false;
                    }
                }

                await this.codeManagementService.checkIfPullRequestShouldBeApproved(
                    {
                        organizationAndTeamData,
                        prNumber,
                        repository: {
                            name: repository?.name,
                            id: repository?.id,
                        },
                    },
                    platformType,
                );
                if (conditionalDecision?.kind === 'approve') {
                    const after =
                        await this.codeManagementService.getReviewStatusByPullRequest(
                            codeManagementRequestData,
                        );
                    if (after !== PullRequestReviewState.APPROVED) {
                        return false;
                    }
                    await this.postConditionalApprovalReason(
                        codeManagementRequestData,
                        platformType,
                        conditionalDecision,
                    );
                }
                return true;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error in shouldApprovePR',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    organizationAndTeamData,
                    platformType,
                    prNumber: pr.number,
                    repository: {
                        name: repository?.name,
                        id: repository?.id,
                    },
                },
                error,
            });

            return false;
        }
    }

    private async postConditionalApprovalReason(
        request: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string };
            prNumber: number;
        },
        platformType: PlatformType,
        decision: ApprovalDecision,
    ): Promise<void> {
        let operation = 'getAllCommentsInPullRequest';
        try {
            const body = formatApprovalReasonComment(
                decision.kind === 'approve' ? 'approve' : 'hold',
                decision.reason,
            );
            // The lookup is only for keeping one reason comment current. A
            // timed-out read may finish later, but cannot post a comment: the
            // write happens only after this bounded await resolves.
            const comments = await runWithBoundedTimeout(
                this.codeManagementService.getAllCommentsInPullRequest(
                    request,
                    platformType,
                ),
                APPROVAL_REASON_LOOKUP_TIMEOUT_MS,
                'conditional approval comment lookup',
            );
            const existing = comments?.find(isApprovalReasonComment);
            const commentId = [
                existing?.id,
                existing?.commentId,
                existing?.note_id,
            ].find(
                (candidate): candidate is number =>
                    typeof candidate === 'number',
            );
            if (typeof commentId === 'number') {
                const previous =
                    existing?.body ?? existing?.note ?? existing?.content;
                if (previous === body) return;
                operation = 'updateIssueComment';
                const updatedComment = await runWithBoundedTimeout(
                    this.codeManagementService.updateIssueComment(
                        { ...request, body, commentId, noteId: commentId },
                        platformType,
                    ),
                    APPROVAL_REASON_WRITE_TIMEOUT_MS,
                    'conditional approval comment update',
                );
                if (updatedComment === null) {
                    throw new Error(
                        'Conditional approval comment update returned null',
                    );
                }
            } else {
                operation = 'createIssueComment';
                const createdComment = await runWithBoundedTimeout(
                    this.codeManagementService.createIssueComment(
                        { ...request, body },
                        platformType,
                    ),
                    APPROVAL_REASON_WRITE_TIMEOUT_MS,
                    'conditional approval comment create',
                );
                if (createdComment === null) {
                    throw new Error(
                        'Conditional approval comment create returned null',
                    );
                }
            }
        } catch (error) {
            this.logger.warn({
                message: 'Could not post conditional approval reason',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    organizationAndTeamData: request.organizationAndTeamData,
                    repositoryId: request.repository.id,
                    prNumber: request.prNumber,
                    operation,
                    lookupTimeoutMs: APPROVAL_REASON_LOOKUP_TIMEOUT_MS,
                    writeTimeoutMs: APPROVAL_REASON_WRITE_TIMEOUT_MS,
                },
            });
        }
    }

    private async hasInProgressReviewExecution({
        teamAutomationId,
        pullRequestNumber,
        repositoryId,
    }: {
        teamAutomationId: string;
        pullRequestNumber: number;
        repositoryId?: string;
    }): Promise<boolean> {
        if (!teamAutomationId || typeof pullRequestNumber !== 'number') {
            return false;
        }

        const inProgressExecutions = await this.automationExecutionService.find(
            {
                teamAutomation: { uuid: teamAutomationId },
                pullRequestNumber,
                ...(repositoryId ? { repositoryId } : {}),
                status: AutomationStatus.IN_PROGRESS,
            },
        );

        return (
            Array.isArray(inProgressExecutions) &&
            inProgressExecutions.length > 0
        );
    }

    private getLastAnalyzedCommitSha(lastAnalyzedCommit?: any): string | null {
        if (!lastAnalyzedCommit) {
            return null;
        }

        if (typeof lastAnalyzedCommit === 'string') {
            return lastAnalyzedCommit;
        }

        if (typeof lastAnalyzedCommit === 'object') {
            if (lastAnalyzedCommit.sha) {
                return lastAnalyzedCommit.sha;
            }
            if (lastAnalyzedCommit.commitSha) {
                return lastAnalyzedCommit.commitSha;
            }
            if (lastAnalyzedCommit.commit?.sha) {
                return lastAnalyzedCommit.commit.sha;
            }
        }

        return null;
    }

    private async setPullRequestMessagesConfig(
        repository: {
            id: string;
            name: string;
        },
        organizationAndTeamData: OrganizationAndTeamData,
        codeReviewConfig?: CodeReviewConfig,
    ): Promise<IPullRequestMessages | null> {
        if (!repository?.id || !organizationAndTeamData?.organizationId) {
            this.logger.warn({
                message:
                    'Missing required data for pull request messages config',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                metadata: {
                    hasRepositoryId: !!repository?.id,
                    hasOrganizationId:
                        !!organizationAndTeamData?.organizationId,
                },
            });
            return null;
        }

        const repositoryId = repository.id;
        const organizationId = organizationAndTeamData.organizationId;
        const directoryId = codeReviewConfig?.directoryId;
        const configLevel = codeReviewConfig?.configLevel;

        // Generate cache key based on lookup hierarchy
        const cacheKey = `${organizationId}:${repositoryId}:${directoryId || 'null'}:${configLevel || 'null'}`;

        // Check cache first
        if (this.pullRequestMessagesCache.has(cacheKey)) {
            return this.pullRequestMessagesCache.get(cacheKey);
        }

        let pullRequestMessagesConfig = null;

        // Hierarchical fallback: DIRECTORY → REPOSITORY → GLOBAL
        if (configLevel === ConfigLevel.DIRECTORY) {
            if (!directoryId) {
                this.logger.warn({
                    message:
                        'Directory configLevel missing directoryId, skipping DIRECTORY lookup',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: { repositoryId, organizationId },
                });
            } else {
                pullRequestMessagesConfig =
                    await this.pullRequestMessagesService.findOne({
                        organizationId,
                        repositoryId,
                        directoryId,
                        configLevel: ConfigLevel.DIRECTORY,
                    });
            }
        }

        if (!pullRequestMessagesConfig) {
            pullRequestMessagesConfig =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    repositoryId,
                    configLevel: ConfigLevel.REPOSITORY,
                });
        }

        if (!pullRequestMessagesConfig) {
            pullRequestMessagesConfig =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    configLevel: ConfigLevel.GLOBAL,
                });
        }

        // Store in cache (even if null)
        this.pullRequestMessagesCache.set(cacheKey, pullRequestMessagesConfig);

        return pullRequestMessagesConfig;
    }
}
