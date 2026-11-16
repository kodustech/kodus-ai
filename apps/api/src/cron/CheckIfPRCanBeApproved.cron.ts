import { calculateBackoffIntervalExact } from '@libs/common/utils/polling/exponential-backoff';
import { usesNamedApprovalPolicies } from '@libs/code-review/domain/approval/migrate-review-settings';
import { REVIEW_SETTINGS_HOLD_REASON } from '@libs/code-review/domain/approval/unavailable-review-settings';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
    IOrganizationParametersService,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';
import {
    isCurrentRiskAssessment,
    riskApprovalVeto,
    type RiskAssessmentResult,
} from '@libs/code-review/domain/risk/risk-assessment';
import {
    prRiskConfigurationKey,
    prRiskDescriptionKey,
} from '@libs/code-review/domain/risk/risk-configuration';
import { ApprovalPoliciesService } from '@libs/code-review/pipeline/services/approval-policies.service';
import { OwnChangeRequestService } from '@libs/code-review/pipeline/services/own-change-request.service';
import {
    hasOpenFinding,
    hostCommentKey,
} from '@libs/code-review/domain/approval/own-change-request';
import { approvalPrMetadataKey } from '@libs/code-review/domain/approval/approval-pr-metadata';
import { isByokConfig, LLM_TASK } from '@libs/llm/byok-config';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
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
    approvalPathsOf,
    approvalPolicyForPlatform,
    approvalPolicyFromConfig,
    evaluateReviewedHeadApproval,
    type ApprovalDecision,
} from '@libs/code-review/domain/approval/approval-decision';
import {
    CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN,
    IConditionalApprovalAccessService,
} from '@libs/code-review/domain/approval/conditional-approval-access.contract';
import {
    APPROVAL_REASON_WRITE_TIMEOUT_MS,
    formatApprovalReasonComment,
    isApprovalReasonComment,
} from '@libs/code-review/infrastructure/approval/approval-reason-comment';
import {
    PullRequest,
    PullRequestReviewState,
} from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
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
import { summarizeProviderError } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryAccessDiagnosis.type';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    IApprovalReasonDeliveryFailure,
    ApprovalReasonDeliveryGuard,
    IPullRequestWithDeliveredSuggestions,
    IPullRequestWithKodyChangeRequest,
} from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

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
// level. The per-PR path includes a database read for the latest review
// execution and several git-provider HTTP calls, including file reads
// when directory or sensitive-path policies apply. A task parked on an HTTP
// round trip holds no pool connection at all, so throttling here buys almost
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
// The cron puts at most PR_CONCURRENCY writes ahead in the installation queue
// (45s), inside APPROVAL_REASON_WRITE_TIMEOUT_MS. No hold reason starts after
// the deadline, so the last ones land inside the 5-minute lock; the next run
// recomputes and posts the rest.
const APPROVAL_REASON_WRITE_DEADLINE_MS = 3 * 60 * 1000;
const APPROVAL_FILES_TIMEOUT_MS = 10_000;
const DIRECTORY_FILE_CACHE_TTL_MS = 10 * 60 * 1000;
// One bound for the whole withdrawal: a status read, a comment list and the
// dismissal itself, each a provider round trip.
const CHANGE_REQUEST_WITHDRAWAL_TIMEOUT_MS = 30_000;
// A host that refuses the dismissal (a token without the role, a branch rule
// restricting who dismisses reviews) refuses it again on the next pass, and
// keeps refusing for as long as the PR is open: each refusal waits four times
// longer than the last, up to a day.
const CHANGE_REQUEST_REFUSAL_BACKOFF_MS = 15 * 60 * 1000;
const CHANGE_REQUEST_REFUSAL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const SHARED_RISK_STALE_REASON =
    'The risk assessment does not match the current PR or risk settings. Run a new review before automatic approval.';

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
    private reasonWriteDeadline = Number.POSITIVE_INFINITY;

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
        @Optional()
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParameters?: IOrganizationParametersService,
        private readonly approvalPolicies?: ApprovalPoliciesService,
        private readonly ownChangeRequest?: OwnChangeRequestService,
    ) {}

    private async sharedRiskIsCurrent(input: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        prNumber: number;
        pullRequest: PullRequest;
        config: CodeReviewConfig;
        risk?: RiskAssessmentResult;
    }): Promise<boolean> {
        if (!this.organizationParameters) return false;
        try {
            const stored = await runWithBoundedTimeout(
                this.organizationParameters.findByKey(
                    OrganizationParametersKey.BYOK_CONFIG,
                    input.organizationAndTeamData,
                ),
                FINAL_PROVIDER_TIMEOUT_MS,
                'risk model configuration lookup',
            );
            const { slot, verdict } = resolveTaskSlot(
                isByokConfig(stored?.configValue)
                    ? stored.configValue
                    : undefined,
                LLM_TASK.riskAssessment,
            );
            if (verdict && !verdict.modelId) return false;
            return isCurrentRiskAssessment(input.risk, {
                organizationId: input.organizationAndTeamData.organizationId,
                repositoryId: input.repositoryId,
                prNumber: input.prNumber,
                headSha: input.pullRequest?.head?.sha ?? '',
                baseSha: input.pullRequest?.base?.sha ?? '',
                configurationKey: prRiskConfigurationKey({
                    criteria: input.config.riskCriteria,
                    language: input.config.languageResultPrompt,
                    modelSlot: slot,
                }),
                descriptionKey: prRiskDescriptionKey(input.pullRequest),
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not verify shared risk configuration for approval',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    organizationAndTeamData: input.organizationAndTeamData,
                    repositoryId: input.repositoryId,
                    prNumber: input.prNumber,
                },
            });
            return false;
        }
    }

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
        this.reasonWriteDeadline =
            Date.now() + APPROVAL_REASON_WRITE_DEADLINE_MS;

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
                        // Conditional policies can finish with no suggestions,
                        // including a sensitive-path hold. Only executions
                        // with a saved decision enter the later no-comment
                        // guard; that guard still rejects unclean reviews.
                        const noSuggestionRefs = eligiblePullRequestRefs.filter(
                            (ref) => ref.mayAllowNoComments,
                        );
                        const noSuggestionPrs = noSuggestionRefs.length
                            ? ((await this.pullRequestService.findPullRequestsWithoutDeliveredSuggestionsForApproval(
                                  organizationId,
                                  noSuggestionRefs,
                                  PullRequestState.OPENED,
                              )) ?? [])
                            : [];
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
                                    let currentPullRequest:
                                        PullRequest | null | undefined;
                                    let directoryChangedPaths:
                                        string[] | undefined;
                                    if (
                                        codeReviewConfigFromRepo.directories
                                            ?.length
                                    ) {
                                        const execution =
                                            await this.automationExecutionService.findLatestExecutionByFilters(
                                                {
                                                    status: [
                                                        AutomationStatus.SUCCESS,
                                                        AutomationStatus.PARTIAL_ERROR,
                                                    ],
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
                                        if (reviewedHead) {
                                            const reportMissingHead =
                                                async () =>
                                                    this.postConditionalApprovalReason(
                                                        {
                                                            organizationAndTeamData,
                                                            repository: {
                                                                id: repository.id,
                                                                name: repository.name,
                                                            },
                                                            prNumber: pr.number,
                                                        },
                                                        pr.provider as PlatformType,
                                                        {
                                                            kind: 'hold',
                                                            reason: 'The source commit could not be verified from the Git provider. Automatic approval will be retried.',
                                                        },
                                                    );
                                            try {
                                                currentPullRequest =
                                                    await this.codeManagementService.getPullRequest(
                                                        {
                                                            organizationAndTeamData,
                                                            repository: {
                                                                id: repository.id,
                                                                name: repository.name,
                                                            },
                                                            prNumber: pr.number,
                                                            includeLabels: true,
                                                        },
                                                        pr.provider as PlatformType,
                                                    );
                                            } catch (error) {
                                                this.logger.warn({
                                                    message:
                                                        'Could not load PR for directory approval policy',
                                                    context:
                                                        CheckIfPRCanBeApprovedCronProvider.name,
                                                    error,
                                                    metadata: {
                                                        ...organizationAndTeamData,
                                                        repositoryId:
                                                            repository.id,
                                                        prNumber: pr.number,
                                                    },
                                                });
                                                await reportMissingHead();
                                                return;
                                            }
                                            if (
                                                !currentPullRequest?.head?.sha
                                            ) {
                                                await reportMissingHead();
                                                return;
                                            }
                                            const currentHead =
                                                currentPullRequest?.head?.sha;
                                            if (
                                                currentHead &&
                                                currentHead !== reviewedHead
                                            ) {
                                                return;
                                            }
                                        }
                                        // A changed base can change the PR diff
                                        // without changing its head. When the
                                        // provider supplies both SHAs, the file
                                        // list is stable for that exact pair.
                                        // Otherwise retain the short TTL.
                                        const currentBase =
                                            currentPullRequest?.base?.sha;
                                        const stableVersion =
                                            reviewedHead &&
                                            currentPullRequest?.head?.sha ===
                                                reviewedHead &&
                                            currentBase;
                                        const cacheKey = reviewedHead
                                            ? `${organizationId}:${repository.id}:${pr.number}:${reviewedHead}${stableVersion ? `:${currentBase}` : ''}`
                                            : null;
                                        const cached = cacheKey
                                            ? this.directoryFilesByReviewedHead.get(
                                                  cacheKey,
                                              )
                                            : undefined;
                                        let files =
                                            cached &&
                                            (stableVersion ||
                                                Date.now() - cached.fetchedAt <
                                                    DIRECTORY_FILE_CACHE_TTL_MS)
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
                                                                    currentPullRequest
                                                                        ?.head
                                                                        ?.sha,
                                                                baseSha:
                                                                    currentPullRequest
                                                                        ?.base
                                                                        ?.sha,
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
                                                const failure =
                                                    summarizeProviderError(
                                                        error,
                                                    );
                                                let reason =
                                                    'Changed files could not be verified from the Git provider. Automatic approval will be retried.';
                                                if (
                                                    failure.includes(
                                                        'bounded timeout',
                                                    )
                                                ) {
                                                    reason =
                                                        'The Git provider timed out while loading changed files. Automatic approval will be retried.';
                                                } else if (
                                                    /^(401|403)\b/.test(failure)
                                                ) {
                                                    reason =
                                                        'The Git provider denied access to changed files. Check the integration permissions before retrying automatic approval.';
                                                } else if (
                                                    /^429\b/.test(failure)
                                                ) {
                                                    reason =
                                                        'The Git provider rate-limited the changed-file lookup. Automatic approval will be retried.';
                                                }
                                                await this.postConditionalApprovalReason(
                                                    {
                                                        organizationAndTeamData,
                                                        repository: {
                                                            id: repository.id,
                                                            name: repository.name,
                                                        },
                                                        prNumber: pr.number,
                                                    },
                                                    pr.provider as PlatformType,
                                                    { kind: 'hold', reason },
                                                );
                                                return;
                                            }
                                            files = liveFiles?.map((file) => ({
                                                filename:
                                                    file.filename ?? file.path,
                                                previous_filename:
                                                    file.previous_filename,
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
                                        if (
                                            !files?.length ||
                                            files.some((file) => !file.filename)
                                        ) {
                                            await this.postConditionalApprovalReason(
                                                {
                                                    organizationAndTeamData,
                                                    repository: {
                                                        id: repository.id,
                                                        name: repository.name,
                                                    },
                                                    prNumber: pr.number,
                                                },
                                                pr.provider as PlatformType,
                                                {
                                                    kind: 'hold',
                                                    reason: !files?.length
                                                        ? 'The Git provider returned no changed files for this PR. Automatic approval is on hold until the file list can be verified.'
                                                        : 'The Git provider did not return a path for every changed file. Automatic approval is on hold until the file list can be verified.',
                                                },
                                            );
                                            return;
                                        }
                                        directoryChangedPaths =
                                            approvalPathsOf(files);
                                        resolvedConfig =
                                            await this.codeBaseConfigService.getConfig(
                                                organizationAndTeamData,
                                                repository,
                                                directoryChangedPaths.map(
                                                    (filename) => ({
                                                        filename,
                                                    }),
                                                ),
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
                                        currentPullRequest,
                                        directoryChangedPaths,
                                    });
                                }),
                            ),
                        );
                    }),
                ),
            );

            // An approval clears Kody's change request by itself, so this
            // runs after them. Every PR that carries the request is judged
            // here on its own terms: it must stop blocking the merge once
            // the findings behind it are resolved, approved by Kody or not.
            if (this.ownChangeRequest) {
                await this.withdrawResolvedChangeRequests(
                    teams,
                    parametersByTeam,
                    teamAutomationsByTeam,
                    teamLimit,
                    prLimit,
                );
            }
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

    /** When a refused withdrawal is tried again, by organization, repository and PR. */
    private readonly changeRequestRefusals = new Map<
        string,
        { until: number; count: number; organizationId: string }
    >();

    private async withdrawResolvedChangeRequests(
        teams: Array<{ uuid: string; organization?: { uuid?: string } }>,
        parametersByTeam: Map<
            string,
            { configValue?: { repositories?: Array<{ id?: string }> } }
        >,
        teamAutomationsByTeam: Map<string, { uuid: string }>,
        teamLimit: <T>(task: () => Promise<T>) => Promise<T>,
        prLimit: <T>(task: () => Promise<T>) => Promise<T>,
    ): Promise<void> {
        // A repository may be reviewed by more than one team of its
        // organization: its PR is still judged once, against the reviews of
        // every one of them.
        const reviewersByRepository = new Map<
            string,
            { teamId: string; teamAutomationId: string }[]
        >();
        const organizationIds = new Set<string>();
        for (const team of teams) {
            const organizationId = team.organization?.uuid;
            const repositories = parametersByTeam.get(team.uuid)?.configValue
                ?.repositories;
            const teamAutomation = teamAutomationsByTeam.get(team.uuid);
            if (
                !organizationId ||
                !Array.isArray(repositories) ||
                !teamAutomation
            ) {
                continue;
            }
            organizationIds.add(organizationId);
            for (const repository of repositories) {
                const key = `${organizationId}:${repository?.id}`;
                const reviewers = reviewersByRepository.get(key) ?? [];
                reviewers.push({
                    teamId: team.uuid,
                    teamAutomationId: teamAutomation.uuid,
                });
                reviewersByRepository.set(key, reviewers);
            }
        }

        const listed = new Set<string>();
        const notListed = new Set<string>();
        await Promise.allSettled(
            [...organizationIds].map((organizationId) =>
                teamLimit(async () => {
                    let pullRequests: IPullRequestWithKodyChangeRequest[];
                    try {
                        pullRequests =
                            await this.pullRequestService.findOpenPullRequestsWithKodyChangeRequest(
                                organizationId,
                            );
                    } catch (error) {
                        notListed.add(organizationId);
                        this.logger.error({
                            message:
                                "Could not list the PRs carrying Kody's change request",
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            error,
                            metadata: { organizationId },
                        });
                        return;
                    }
                    await Promise.allSettled(
                        pullRequests.map((pullRequest) => {
                            const repositoryKey = `${organizationId}:${pullRequest.repository?.id}`;
                            const reviewers =
                                reviewersByRepository.get(repositoryKey);
                            if (!reviewers) return undefined;
                            const key = `${repositoryKey}:${pullRequest.number}`;
                            listed.add(key);
                            return prLimit(() =>
                                this.withdrawResolvedChangeRequest(
                                    key,
                                    {
                                        organizationId,
                                        teamId: reviewers[0].teamId,
                                    },
                                    pullRequest,
                                    reviewers.map(
                                        (reviewer) => reviewer.teamAutomationId,
                                    ),
                                ),
                            );
                        }),
                    );
                }),
            ),
        );

        // A PR that left the list (closed, withdrawn, approved) has nothing
        // left to wait for. A list that could not be read says nothing about
        // its PRs, so their waits stand.
        for (const [key, refusal] of this.changeRequestRefusals) {
            if (!listed.has(key) && !notListed.has(refusal.organizationId)) {
                this.changeRequestRefusals.delete(key);
            }
        }
    }

    private async withdrawResolvedChangeRequest(
        key: string,
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: IPullRequestWithKodyChangeRequest,
        teamAutomationIds: string[],
    ): Promise<void> {
        const refusal = this.changeRequestRefusals.get(key);
        if (refusal && refusal.until > Date.now()) {
            return;
        }
        try {
            await runWithBoundedTimeout(
                this.ownChangeRequest.withdrawIfResolved({
                    organizationAndTeamData,
                    pullRequest,
                    // A review still running may be about to request changes
                    // over a finding this pass has not seen.
                    isReviewRunning: async () =>
                        (
                            await Promise.all(
                                teamAutomationIds.map((teamAutomationId) =>
                                    this.hasInProgressReviewExecution({
                                        teamAutomationId,
                                        pullRequestNumber: pullRequest.number,
                                        repositoryId:
                                            pullRequest.repository?.id,
                                    }),
                                ),
                            )
                        ).some(Boolean),
                }),
                CHANGE_REQUEST_WITHDRAWAL_TIMEOUT_MS,
                'change request withdrawal',
            );
            this.changeRequestRefusals.delete(key);
        } catch (error) {
            const count = (refusal?.count ?? 0) + 1;
            const wait = calculateBackoffIntervalExact(count - 1, {
                baseInterval: CHANGE_REQUEST_REFUSAL_BACKOFF_MS,
                maxInterval: CHANGE_REQUEST_REFUSAL_BACKOFF_MAX_MS,
                multiplier: 4,
            });
            this.changeRequestRefusals.set(key, {
                until: Date.now() + wait,
                count,
                organizationId: organizationAndTeamData.organizationId,
            });
            this.logger.warn({
                message: `Could not withdraw Kody's change request on PR#${pullRequest.number} (attempt ${count}); next attempt in ${Math.round(wait / 60_000)} minutes`,
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId: pullRequest.repository?.id,
                    prNumber: pullRequest.number,
                },
            });
        }
    }

    private async approveByNamedPolicy(input: {
        organizationAndTeamData: OrganizationAndTeamData;
        pr: IPullRequestWithDeliveredSuggestions;
        codeReviewConfig: CodeReviewConfig;
        teamAutomationId: string;
    }): Promise<boolean> {
        const {
            organizationAndTeamData,
            pr,
            codeReviewConfig,
            teamAutomationId,
        } = input;
        const request = {
            organizationAndTeamData,
            repository: pr.repository,
            prNumber: pr.number,
        };
        const platformType = pr.provider as PlatformType;
        const hold = async (reason: string) => {
            await this.postConditionalApprovalReason(request, platformType, {
                kind: 'hold',
                reason,
            });
            return false;
        };
        try {
            if (!codeReviewConfig.pullRequestApprovalActive) return false;
            const status = await runWithBoundedTimeout(
                this.codeManagementService.getReviewStatusByPullRequest(
                    request,
                ),
                FINAL_PROVIDER_TIMEOUT_MS,
                'policy approval status',
            );
            // Policy edits never rewrite an existing approval. Only repair an
            // explanation whose delivery failed after our confirmed approval.
            if (status === PullRequestReviewState.APPROVED) {
                const failure = pr.approvalReasonDeliveryFailure;
                if (
                    failure?.decision === 'approve' &&
                    failure.reviewedHeadSha &&
                    failure.reviewedBaseSha
                ) {
                    try {
                        const live = await runWithBoundedTimeout(
                            this.codeManagementService.getPullRequest(
                                request,
                                platformType,
                            ),
                            FINAL_PROVIDER_TIMEOUT_MS,
                            'approval reason retry snapshot',
                        );
                        if (
                            live?.head?.sha === failure.reviewedHeadSha &&
                            live?.base?.sha === failure.reviewedBaseSha
                        ) {
                            await this.postConditionalApprovalReason(
                                request,
                                platformType,
                                {
                                    kind: 'approve',
                                    reason: failure.reason,
                                    reviewedHeadSha: failure.reviewedHeadSha,
                                    reviewedBaseSha: failure.reviewedBaseSha,
                                },
                                failure,
                            );
                        }
                    } catch (error) {
                        this.logger.warn({
                            message:
                                'Could not retry a confirmed approval reason',
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            error,
                            metadata: {
                                organizationAndTeamData,
                                repositoryId: pr.repository.id,
                                prNumber: pr.number,
                            },
                        });
                    }
                }
                return false;
            }
            if (status == null || !this.approvalPolicies)
                return hold('Approval conditions could not be verified.');
            const latest =
                await this.automationExecutionService.findLatestExecutionByFilters(
                    {
                        teamAutomation: { uuid: teamAutomationId },
                        pullRequestNumber: pr.number,
                        repositoryId: pr.repository.id,
                    },
                );
            if (latest?.status !== AutomationStatus.SUCCESS)
                return hold('The latest review did not complete.');
            const data = latest.dataExecution;
            const reviewed = data?.approvalDecision as
                ApprovalDecision | undefined;
            const summary = data?.approvalReviewSummary;
            if (
                !summary?.complete ||
                !reviewed?.reviewedHeadSha ||
                !reviewed.reviewedBaseSha
            )
                return hold(
                    'Run a complete PR review before automatic approval.',
                );
            const live = await runWithBoundedTimeout(
                this.codeManagementService.getPullRequest(
                    { ...request, includeLabels: true },
                    platformType,
                ),
                FINAL_PROVIDER_TIMEOUT_MS,
                'policy PR snapshot',
            );
            if (
                live?.head?.sha !== reviewed.reviewedHeadSha ||
                live?.base?.sha !== reviewed.reviewedBaseSha ||
                this.getLastAnalyzedCommitSha(data.lastAnalyzedCommit) !==
                    reviewed.reviewedHeadSha
            )
                return hold('The PR changed after it was reviewed.');
            if (summary.prFindings > 0)
                return hold(
                    'PR-level findings require a new clean review before automatic approval.',
                );
            if (summary.lineFindings > 0 || pr.suggestions?.length) {
                if (!pr.suggestions?.length)
                    return hold('Review findings could not be verified.');
                const comments = await runWithBoundedTimeout(
                    platformType === PlatformType.GITHUB
                        ? this.codeManagementService.getPullRequestReviewThreads(
                              request,
                              platformType,
                          )
                        : this.codeManagementService.getPullRequestReviewComments(
                              request,
                              platformType,
                          ),
                    FINAL_PROVIDER_TIMEOUT_MS,
                    'policy review findings',
                );
                if (!Array.isArray(comments))
                    return hold('Review findings remain unresolved.');
                if (
                    hasOpenFinding(
                        pr.suggestions.map((suggestion) =>
                            String(suggestion.comment?.id),
                        ),
                        comments,
                        platformType,
                    )
                )
                    return hold('Review findings remain unresolved.');
            }
            if (
                codeReviewConfig.riskAssessmentActive === true &&
                !(await this.sharedRiskIsCurrent({
                    organizationAndTeamData,
                    repositoryId: pr.repository.id,
                    prNumber: pr.number,
                    pullRequest: live,
                    config: codeReviewConfig,
                    risk: data.riskAssessment,
                }))
            )
                return hold(SHARED_RISK_STALE_REASON);
            const { decision, eligibility } =
                await this.approvalPolicies.evaluate({
                    organizationAndTeamData,
                    repository: pr.repository,
                    pullRequest: { ...live, number: pr.number },
                    config: codeReviewConfig,
                    platformType,
                    reviewClean: true,
                    risk: data.riskAssessment,
                    heavy: data.heavy,
                    previousEligibility: data.approvalPolicyEligibility,
                });
            if (Object.keys(eligibility).length)
                await this.automationExecutionService.update(
                    { uuid: latest.uuid },
                    {
                        dataExecution: {
                            ...data,
                            approvalPolicyEligibility: eligibility,
                        },
                    },
                );
            if (decision.kind !== 'approve') {
                await this.postConditionalApprovalReason(
                    request,
                    platformType,
                    decision,
                );
                return false;
            }
            if (
                await this.hasInProgressReviewExecution({
                    teamAutomationId,
                    pullRequestNumber: pr.number,
                    repositoryId: pr.repository.id,
                })
            )
                return false;
            // A failed or partial rerun that finished during policy evaluation also wins.
            const finalExecution =
                await this.automationExecutionService.findLatestExecutionByFilters(
                    {
                        teamAutomation: { uuid: teamAutomationId },
                        pullRequestNumber: pr.number,
                        repositoryId: pr.repository.id,
                    },
                );
            if (
                finalExecution?.uuid !== latest.uuid ||
                finalExecution?.status !== AutomationStatus.SUCCESS
            )
                return hold(
                    'A newer review must complete before automatic approval.',
                );
            const finalPr = await runWithBoundedTimeout(
                this.codeManagementService.getPullRequest(
                    { ...request, includeLabels: true },
                    platformType,
                ),
                FINAL_PROVIDER_TIMEOUT_MS,
                'policy final snapshot',
            );
            if (
                finalPr?.head?.sha !== decision.reviewedHeadSha ||
                finalPr?.base?.sha !== decision.reviewedBaseSha ||
                approvalPrMetadataKey(finalPr) !== decision.reviewedMetadataKey
            )
                return hold(
                    'The PR changed while approval conditions were evaluated.',
                );
            const approvalAttemptAt = new Date().toISOString();
            await this.codeManagementService.approvePullRequest(
                { ...request, headSha: decision.reviewedHeadSha },
                platformType,
            );
            if (
                (await this.codeManagementService.getReviewStatusByPullRequest(
                    request,
                )) !== PullRequestReviewState.APPROVED
            )
                return hold('The provider did not confirm automatic approval.');
            await this.postConditionalApprovalReason(
                request,
                platformType,
                decision,
                undefined,
                approvalAttemptAt,
            );
            return true;
        } catch (error) {
            this.logger.warn({
                message: 'Approval policy verification failed',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId: pr.repository.id,
                    prNumber: pr.number,
                },
            });
            return hold('Approval conditions could not be verified.');
        }
    }

    private async shouldApprovePR({
        organizationAndTeamData,
        pr,
        codeReviewConfig,
        teamAutomationId,
        currentPullRequest: preloadedPullRequest,
        directoryChangedPaths,
    }: {
        organizationAndTeamData: OrganizationAndTeamData;
        pr: IPullRequestWithDeliveredSuggestions;
        codeReviewConfig?: CodeReviewConfig;
        teamAutomationId: string;
        currentPullRequest?: PullRequest | null;
        directoryChangedPaths?: string[];
    }): Promise<boolean> {
        if (codeReviewConfig?.reviewSettingsError) {
            await this.postConditionalApprovalReason(
                {
                    organizationAndTeamData,
                    repository: pr.repository,
                    prNumber: pr.number,
                },
                pr.provider as PlatformType,
                { kind: 'hold', reason: REVIEW_SETTINGS_HOLD_REASON },
            );
            return false;
        }
        if (usesNamedApprovalPolicies(codeReviewConfig))
            return this.approveByNamedPolicy({
                organizationAndTeamData,
                pr,
                codeReviewConfig,
                teamAutomationId,
            });
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
        const allowNoComments = policyActive && noSuggestions;
        if (noSuggestions && !allowNoComments) {
            return false;
        }
        const lastExecution =
            await this.automationExecutionService.findLatestExecutionByFilters({
                status: [
                    AutomationStatus.SUCCESS,
                    AutomationStatus.PARTIAL_ERROR,
                ],
                teamAutomation: { uuid: teamAutomationId },
                pullRequestNumber: prNumber,
                repositoryId: repository?.id,
            });
        // Read partial executions so a failed rerun cannot expose an older
        // successful judgment. Partial reviews cannot issue a new approval.
        if (
            lastExecution?.status === AutomationStatus.PARTIAL_ERROR &&
            !policyActive
        ) {
            return false;
        }
        const lastAnalyzedCommitSha = this.getLastAnalyzedCommitSha(
            lastExecution?.dataExecution?.lastAnalyzedCommit,
        );
        let changedPaths: string[] = directoryChangedPaths ?? [];
        const reviewedDecision = lastExecution?.dataExecution?.approvalDecision;
        // Only pre-deploy legacy judgments may use the old head-bound result.
        // Independent choices and every new shared result require its snapshot.
        const needsSharedRisk =
            codeReviewConfig?.riskAssessmentActive === true &&
            (codeReviewConfig.riskAssessmentSource !== 'legacy' ||
                !!lastExecution?.dataExecution?.riskAssessment);
        if (
            allowNoComments &&
            (!['approve', 'hold', 'out-of-scope'].includes(
                reviewedDecision?.kind,
            ) ||
                reviewedDecision?.reason === 'The review is not clean.')
        ) {
            return false;
        }
        let currentPullRequest = preloadedPullRequest;

        if (lastAnalyzedCommitSha || policyActive) {
            if (!currentPullRequest) {
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
            }

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
                if (
                    reviewedDecision?.reviewedBaseSha &&
                    currentPullRequest?.base?.sha !==
                        reviewedDecision.reviewedBaseSha
                ) {
                    await this.postConditionalApprovalReason(
                        codeManagementRequestData,
                        platformType,
                        {
                            kind: 'hold',
                            reason: 'The target branch changed after this PR was reviewed.',
                        },
                    );
                    return false;
                }
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
                if (preloadedPullRequest && !preloadedPullRequest.base?.sha) {
                    await this.postConditionalApprovalReason(
                        codeManagementRequestData,
                        platformType,
                        {
                            kind: 'hold',
                            reason: 'The target branch commit could not be verified for the directory policy.',
                        },
                    );
                    return false;
                }
                if (lastExecution.status === AutomationStatus.PARTIAL_ERROR) {
                    // The approval can succeed before publishing its explanation
                    // fails. Repair that comment only after verifying the host;
                    // a saved decision alone must never replay a partial review.
                    if (reviewedDecision?.kind === 'approve') {
                        const hostStatus = await runWithBoundedTimeout(
                            this.codeManagementService.getReviewStatusByPullRequest(
                                codeManagementRequestData,
                            ),
                            FINAL_PROVIDER_TIMEOUT_MS,
                            'approval provider-status lookup',
                        ).catch((error) => {
                            this.logger.warn({
                                message:
                                    'Could not verify approval for partial review reconciliation',
                                context:
                                    CheckIfPRCanBeApprovedCronProvider.name,
                                error,
                                metadata: {
                                    organizationAndTeamData,
                                    repositoryId: repository?.id,
                                    prNumber,
                                },
                            });
                            return null;
                        });
                        if (hostStatus == null) return false;
                        if (hostStatus === PullRequestReviewState.APPROVED) {
                            await this.postConditionalApprovalReason(
                                codeManagementRequestData,
                                platformType,
                                reviewedDecision,
                            );
                            return false;
                        }
                    }
                    await this.postConditionalApprovalReason(
                        codeManagementRequestData,
                        platformType,
                        {
                            kind: 'hold',
                            reason:
                                reviewedDecision?.kind === 'hold'
                                    ? reviewedDecision.reason
                                    : 'The latest review did not complete successfully. A new successful review is required before automatic approval.',
                        },
                    );
                    return false;
                }
                if (policy.sensitivePaths?.length && !directoryChangedPaths) {
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
                                    headSha: currentPullRequest?.head?.sha,
                                    baseSha: currentPullRequest?.base?.sha,
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
                        await this.postConditionalApprovalReason(
                            codeManagementRequestData,
                            platformType,
                            {
                                kind: 'hold',
                                reason: 'Changed files could not be verified for the sensitive-path policy. Automatic approval will be retried.',
                            },
                        );
                        return false;
                    }
                    if (
                        !files?.length ||
                        files.some((file) => !(file.filename ?? file.path))
                    ) {
                        await this.postConditionalApprovalReason(
                            codeManagementRequestData,
                            platformType,
                            {
                                kind: 'hold',
                                reason: 'The Git provider returned an incomplete changed-file list for the sensitive-path policy. Automatic approval is on hold until the files can be verified.',
                            },
                        );
                        return false;
                    }
                    changedPaths = approvalPathsOf(files);
                }
                // A head approved while risk assessment was off keeps that
                // approval only if the host still shows it; asked only then.
                const approvedOnHost =
                    !!policy?.assessRisk &&
                    !lastExecution.dataExecution?.approvalRisk &&
                    reviewedDecision?.kind === 'approve' &&
                    (await runWithBoundedTimeout(
                        this.codeManagementService.getReviewStatusByPullRequest(
                            codeManagementRequestData,
                        ),
                        FINAL_PROVIDER_TIMEOUT_MS,
                        'approval provider-status lookup',
                    ).catch((error) => {
                        this.logger.warn({
                            message:
                                'Could not read whether the reviewed head is still approved',
                            context: CheckIfPRCanBeApprovedCronProvider.name,
                            error,
                            metadata: {
                                organizationAndTeamData,
                                repositoryId: repository?.id,
                                prNumber,
                                reviewedHeadSha: lastAnalyzedCommitSha,
                                timeoutMs: FINAL_PROVIDER_TIMEOUT_MS,
                            },
                        });
                        return null;
                    })) === PullRequestReviewState.APPROVED;
                if (
                    needsSharedRisk &&
                    !approvedOnHost &&
                    !(await this.sharedRiskIsCurrent({
                        organizationAndTeamData,
                        repositoryId: repository.id,
                        prNumber,
                        pullRequest: currentPullRequest,
                        config: codeReviewConfig,
                        risk: lastExecution.dataExecution?.riskAssessment,
                    }))
                ) {
                    await this.postConditionalApprovalReason(
                        codeManagementRequestData,
                        platformType,
                        { kind: 'hold', reason: SHARED_RISK_STALE_REASON },
                    );
                    return false;
                }
                const sharedVeto = lastExecution.dataExecution?.riskAssessment
                    ? riskApprovalVeto(
                          codeReviewConfig?.riskAssessmentActive === true,
                          lastExecution.dataExecution.riskAssessment,
                          currentHeadSha,
                          currentPullRequest,
                      )
                    : undefined;
                if (sharedVeto) {
                    await this.postConditionalApprovalReason(
                        codeManagementRequestData,
                        platformType,
                        { kind: 'hold', reason: sharedVeto },
                    );
                    return false;
                }
                const decision = evaluateReviewedHeadApproval({
                    approvalActive: true,
                    reviewedDecision,
                    approvedOnHost,
                    policy,
                    author:
                        currentPullRequest?.user?.login ??
                        (
                            currentPullRequest?.user as
                                { username?: string } | undefined
                        )?.username,
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
                // A prior hold can become an approval only after another
                // review confirms that the now-changed policy is safe.
                if (allowNoComments && reviewedDecision?.kind === 'hold') {
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
                    const commentId = comment
                        ? hostCommentKey(comment, platformType)
                        : undefined;

                    return !!commentId && deliveredCommentIds.has(commentId);
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
                    const directoryPolicyBaseSha =
                        reviewedDecision?.reviewedBaseSha ??
                        preloadedPullRequest?.base?.sha;
                    const directoryBaseChanged =
                        (!!preloadedPullRequest ||
                            !!reviewedDecision?.reviewedBaseSha) &&
                        (!directoryPolicyBaseSha ||
                            latestPullRequest?.base?.sha !==
                                directoryPolicyBaseSha);
                    if (
                        !latestHeadSha ||
                        latestHeadSha !== lastAnalyzedCommitSha ||
                        directoryBaseChanged ||
                        (policy?.labels?.length && !latestPullRequest?.labels)
                    ) {
                        if (directoryBaseChanged) {
                            await this.postConditionalApprovalReason(
                                codeManagementRequestData,
                                platformType,
                                {
                                    kind: 'hold',
                                    reason: 'The target branch changed while the directory policy was checked. Approval will be reconsidered on the next pass.',
                                },
                            );
                        }
                        return false;
                    }
                    if (
                        needsSharedRisk &&
                        !(await this.sharedRiskIsCurrent({
                            organizationAndTeamData,
                            repositoryId: repository.id,
                            prNumber,
                            pullRequest: latestPullRequest,
                            config: codeReviewConfig,
                            risk: lastExecution.dataExecution?.riskAssessment,
                        }))
                    ) {
                        await this.postConditionalApprovalReason(
                            codeManagementRequestData,
                            platformType,
                            { kind: 'hold', reason: SHARED_RISK_STALE_REASON },
                        );
                        return false;
                    }
                    conditionalDecision = {
                        ...evaluateReviewedHeadApproval({
                            approvalActive: true,
                            reviewedDecision,
                            policy,
                            author: latestPullRequest?.user?.login,
                            labels: latestPullRequest?.labels,
                            changedPaths,
                            reviewClean: true,
                            risk: lastExecution?.dataExecution?.approvalRisk,
                            currentHeadSha: latestHeadSha,
                        }),
                        reviewedHeadSha: latestHeadSha,
                        reviewedBaseSha: latestPullRequest?.base?.sha,
                        reviewedMetadataKey:
                            approvalPrMetadataKey(latestPullRequest),
                    };
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

                const approvalAttemptAt = new Date().toISOString();
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
                        undefined,
                        approvalAttemptAt,
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
        expectedFailure?: IApprovalReasonDeliveryFailure,
        publicationAttemptAt?: string,
    ): Promise<void> {
        // A hold is recomputed on every run, so a late one waits for the next.
        // An approval's reason is not: it is always posted.
        if (
            decision.kind !== 'approve' &&
            Date.now() >= this.reasonWriteDeadline
        ) {
            return;
        }
        const occurredAt = publicationAttemptAt ?? new Date().toISOString();
        const guard = {
            notAfter: occurredAt,
            ...(expectedFailure ? { expectedFailure } : {}),
        };
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
                    { ...request, failOnError: true },
                    platformType,
                ),
                APPROVAL_REASON_LOOKUP_TIMEOUT_MS,
                'conditional approval comment lookup',
            );
            if (!Array.isArray(comments)) {
                throw new Error(
                    'Conditional approval comment lookup returned no result',
                );
            }
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
                if (previous !== body) {
                    operation = 'updateIssueComment';
                    const updatedComment = await runWithBoundedTimeout(
                        this.codeManagementService.updateIssueComment(
                            {
                                ...request,
                                body,
                                commentId,
                                noteId: commentId,
                                threadId: existing?.threadId,
                            },
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
            await this.recordApprovalReasonDelivery(request, null, guard);
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
            await this.recordApprovalReasonDelivery(
                request,
                {
                    decision: decision.kind === 'approve' ? 'approve' : 'hold',
                    reason: decision.reason,
                    occurredAt: expectedFailure?.occurredAt ?? occurredAt,
                    ...(decision.kind === 'approve' &&
                    decision.reviewedHeadSha &&
                    decision.reviewedBaseSha
                        ? {
                              reviewedHeadSha: decision.reviewedHeadSha,
                              reviewedBaseSha: decision.reviewedBaseSha,
                          }
                        : {}),
                },
                guard,
            );
        }
    }

    private async recordApprovalReasonDelivery(
        request: {
            organizationAndTeamData: OrganizationAndTeamData;
            repository: { id: string; name: string };
            prNumber: number;
        },
        failure: IApprovalReasonDeliveryFailure | null,
        guard?: ApprovalReasonDeliveryGuard,
    ): Promise<void> {
        let organizationAndTeamData: OrganizationAndTeamData | undefined;
        let repositoryId: string | undefined;
        let prNumber: number | undefined;
        try {
            organizationAndTeamData = request.organizationAndTeamData;
            repositoryId = request.repository.id;
            prNumber = request.prNumber;
            const persisted =
                await this.pullRequestService.setApprovalReasonDeliveryFailure(
                    organizationAndTeamData.organizationId,
                    repositoryId,
                    prNumber,
                    failure,
                    guard,
                );
            if (!persisted) {
                this.logger.warn({
                    message:
                        'Approval reason delivery status was not changed: PR missing or notice superseded',
                    context: CheckIfPRCanBeApprovedCronProvider.name,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId,
                        prNumber,
                    },
                });
            }
        } catch (error) {
            this.logger.error({
                message:
                    'Could not persist conditional approval delivery status',
                context: CheckIfPRCanBeApprovedCronProvider.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId,
                    prNumber,
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
