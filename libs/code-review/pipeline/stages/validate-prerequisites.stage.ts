import { createLogger } from '@libs/core/log/logger';
import { LLM_TASK } from '@libs/llm/byok-config';
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import {
    ForgejoReaction,
    GitHubReaction,
    GitlabReaction,
} from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import {
    OrganizationParametersKey,
    PlatformType,
} from '@libs/core/domain/enums';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { PipelineReason } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-reason.interface';
import { IStageValidationResult } from '@libs/core/infrastructure/pipeline/interfaces/stage-result.interface';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { environment } from '@libs/ee/configs/environment';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { AutoAssignLicenseUseCase } from '@libs/ee/license/use-cases/auto-assign-license.use-case';
import {
    PermissionValidationService,
    ValidationErrorType,
} from '@libs/ee/shared/services/permissionValidation.service';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersAutoAssignConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationRateLimiter } from '@libs/notifications/application/notification-rate-limiter.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { recipientByRole } from '@libs/notifications/domain/recipient';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

const SKIPPED_NO_LICENSE_RATE_LIMIT_TTL_SECONDS = 24 * 60 * 60; // 24h

type NoActiveSubscriptionType =
    | 'user'
    | 'general'
    | 'byok_required'
    | 'trial_credits_exhausted'
    | 'license_unavailable'
    | 'no_error';

const ERROR_TO_MESSAGE_TYPE: Record<
    ValidationErrorType,
    NoActiveSubscriptionType
> = {
    [ValidationErrorType.INVALID_LICENSE]: 'general',
    [ValidationErrorType.USER_NOT_LICENSED]: 'user',
    [ValidationErrorType.BYOK_REQUIRED]: 'byok_required',
    [ValidationErrorType.PLAN_LIMIT_EXCEEDED]: 'general',
    [ValidationErrorType.NOT_ERROR]: 'no_error',
};

const NO_LICENSE_REACTION_MAP = {
    [PlatformType.GITHUB]: GitHubReaction.THUMBS_DOWN,
    [PlatformType.GITLAB]: GitlabReaction.LOCK,
    [PlatformType.FORGEJO]: ForgejoReaction.THUMBS_DOWN,
};

@Injectable()
export class ValidatePrerequisitesStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'ValidatePrerequisitesStage';
    readonly label = 'Checking Prerequisites';
    readonly visibility = StageVisibility.PRIMARY;
    private readonly logger = createLogger(ValidatePrerequisitesStage.name);

    constructor(
        private readonly permissionValidationService: PermissionValidationService,
        private readonly autoAssignLicenseUseCase: AutoAssignLicenseUseCase,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly codeManagementService: CodeManagementService,
        private readonly notificationService: NotificationService,
        private readonly notificationRateLimiter: NotificationRateLimiter,
        private readonly prAuthorRecipientResolver: PrAuthorRecipientResolver,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const { organizationAndTeamData, userGitId, pullRequest } = context;
        const showStatusFeedback =
            await this.isShowStatusFeedbackEnabled(context);
        const applyShowStatusFeedbackMetadata = (
            draft: CodeReviewPipelineContext,
        ) => {
            if (!draft.pipelineMetadata) {
                draft.pipelineMetadata = {};
            }

            draft.pipelineMetadata.showStatusFeedback = showStatusFeedback;

            if (!showStatusFeedback) {
                draft.pipelineMetadata.notificationHandled = true;
            }
        };

        const prerequisitesResult = this.validatePrerequisites(context);

        if (!prerequisitesResult.canProceed) {
            this.logger.log({
                message: prerequisitesResult.details?.message,
                context: this.stageName,
                metadata: {
                    ...prerequisitesResult.details?.metadata,
                    reason: prerequisitesResult.details?.reasonCode,
                },
            });

            return this.updateContext(context, (draft) => {
                applyShowStatusFeedbackMetadata(draft);
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message:
                        prerequisitesResult.details?.message ||
                        AutomationMessage.VALIDATION_FAILED,
                };
            });
        }

        // Check if user is ignored BEFORE validation
        const isIgnored = await this.isUserIgnored(
            organizationAndTeamData,
            userGitId,
        );

        if (isIgnored) {
            this.logger.log({
                message: 'User is ignored, skipping automation',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData,
                    userGitId,
                    prNumber: pullRequest?.number,
                },
            });

            return this.updateContext(context, (draft) => {
                applyShowStatusFeedbackMetadata(draft);
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: AutomationMessage.USER_IGNORED,
                };
            });
        }

        const centralizedConfigDisablesReviewForRepository =
            await this.isCentralizedConfigRepositoryReviewDisabled(
                organizationAndTeamData,
                context.repository,
            );

        if (centralizedConfigDisablesReviewForRepository) {
            this.logger.log({
                message:
                    'Repository is centralized-config source, skipping automation',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData,
                    repositoryName: context.repository?.name,
                    repositoryId: context.repository?.id,
                    prNumber: pullRequest?.number,
                },
            });

            return this.updateContext(context, (draft) => {
                applyShowStatusFeedbackMetadata(draft);
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message:
                        'Code reviews are disabled for the centralized config repository',
                };
            });
        }

        const globalRulesSourceDisablesReviewForRepository =
            await this.isGlobalRulesSourceRepositoryReviewDisabled(
                organizationAndTeamData,
                context.repository,
            );

        if (globalRulesSourceDisablesReviewForRepository) {
            this.logger.log({
                message:
                    'Repository is a global Kody Rules source, skipping automation',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData,
                    repositoryName: context.repository?.name,
                    repositoryId: context.repository?.id,
                    prNumber: pullRequest?.number,
                },
            });

            return this.updateContext(context, (draft) => {
                applyShowStatusFeedbackMetadata(draft);
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message:
                        'Code reviews are disabled for the global Kody Rules source repository',
                };
            });
        }

        // Centralized permission validation. Consumption is deliberately OFF
        // here: this stage only GATES (blocks when managed trial credits are
        // exhausted). The credit is consumed only after the review reaches a
        // successful terminal state (SUCCESS / PARTIAL_ERROR) in
        // CodeReviewHandlerService — so a review that ends in ERROR or SKIPPED
        // never costs the user a free trial review. The consume there rebuilds
        // the same repo:pr usageKey, keeping it idempotent per PR.
        const validationOptions = {
            consumeTrialReviewCredit: false,
        };

        let validationResult =
            await this.permissionValidationService.validateExecutionPermissions(
                organizationAndTeamData,
                userGitId,
                ValidatePrerequisitesStage.name,
                validationOptions,
            );

        // Safety net for the "onboarded but never got a trial" gap: the trial
        // was historically created only by the browser at the end of
        // onboarding, so a closed tab or a silent billing failure could leave
        // a fully-onboarded org without any license. If the org has no valid
        // license yet its onboarding is complete, provision the trial now and
        // re-validate so this very review can proceed instead of posting a
        // "your trial has ended" comment.
        if (
            !validationResult.allowed &&
            validationResult.errorType === ValidationErrorType.INVALID_LICENSE &&
            (await this.tryHealMissingTrial(context))
        ) {
            validationResult =
                await this.permissionValidationService.validateExecutionPermissions(
                    organizationAndTeamData,
                    userGitId,
                    ValidatePrerequisitesStage.name,
                    validationOptions,
                );
        }

        if (
            validationResult.allowed ||
            validationResult.errorType === ValidationErrorType.NOT_ERROR
        ) {
            // Validation passed
            return this.updateContext(context, (draft) => {
                applyShowStatusFeedbackMetadata(draft);
                if (validationResult.byokConfig) {
                    if (!draft.codeReviewConfig) {
                        draft.codeReviewConfig = {} as any;
                    }
                    const healedByok = validationResult.byokConfig;
                    draft.codeReviewConfig.byokConfig = healedByok;
                    // Thread the resolved slot the downstream stages read their
                    // limit/telemetry metadata off. The permission service now
                    // returns the bare model slot directly.
                    draft.codeReviewConfig.resolvedModelSlot = (healedByok ??
                        undefined) as unknown as NormalizedModel | undefined;
                }
                if (validationResult.subscriptionStatus) {
                    if (!draft.pipelineMetadata) {
                        draft.pipelineMetadata = {};
                    }
                    draft.pipelineMetadata.subscriptionStatus =
                        validationResult.subscriptionStatus;
                }
            });
        }

        // If validation failed due to USER_NOT_LICENSED, try auto-assign FIRST
        // (before checking autoReviewEnabled, because auto-assign should work regardless)
        if (
            validationResult.errorType === ValidationErrorType.USER_NOT_LICENSED
        ) {
            const failureHandled = await this.handleValidationFailure(
                context,
                validationResult,
                showStatusFeedback,
            );

            if (failureHandled === 'auto_assigned') {
                // Auto-assign succeeded, continue with review
                return this.updateContext(context, (draft) => {
                    applyShowStatusFeedbackMetadata(draft);
                });
            }

            // Auto-assign failed - skip review with notification already handled
            await this.notifySkippedNoLicense(context);
            return this.updateContext(context, (draft) => {
                applyShowStatusFeedbackMetadata(draft);
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: StageMessageHelper.skippedWithReason(
                        this.getLicenseSkipReason(
                            validationResult.errorType,
                            validationResult.subscriptionStatus,
                            validationResult.metadata?.trialCreditsExhausted,
                        ),
                    ),
                };
                // Notification already posted by handleValidationFailure above
                if (!draft.pipelineMetadata) {
                    draft.pipelineMetadata = {};
                }
                draft.pipelineMetadata.notificationHandled = true;
            });
        }

        // For other errors, check autoReviewEnabled BEFORE handling failure
        // (these errors don't benefit from auto-assign)

        try {
            if (context.origin !== 'command') {
                const autoReviewEnabled =
                    await this.isAutomatedReviewActive(context);
                if (!autoReviewEnabled) {
                    return this.updateContext(context, (draft) => {
                        applyShowStatusFeedbackMetadata(draft);
                        draft.statusInfo = {
                            status: AutomationStatus.SKIPPED,
                            message: AutomationMessage.VALIDATION_FAILED,
                        };
                    });
                }
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Error checking automatedReviewActive, proceeding with notification',
                context: this.stageName,
                error,
            });
        }

        // Handle other validation failures (INVALID_LICENSE, BYOK_REQUIRED, etc.)
        await this.handleValidationFailure(
            context,
            validationResult,
            showStatusFeedback,
        );

        // Return SKIPPED - notification already handled by handleValidationFailure
        return this.updateContext(context, (draft) => {
            applyShowStatusFeedbackMetadata(draft);
            draft.statusInfo = {
                status: AutomationStatus.SKIPPED,
                message: StageMessageHelper.skippedWithReason(
                    this.getLicenseSkipReason(
                        validationResult.errorType,
                        validationResult.subscriptionStatus,
                        validationResult.metadata?.trialCreditsExhausted,
                    ),
                ),
            };
            if (!draft.pipelineMetadata) {
                draft.pipelineMetadata = {};
            }
            draft.pipelineMetadata.notificationHandled = true;
        });
    }

    private getLicenseSkipReason(
        errorType?: ValidationErrorType,
        subscriptionStatus?: string,
        trialCreditsExhausted?: boolean,
    ): PipelineReason {
        switch (errorType) {
            case ValidationErrorType.BYOK_REQUIRED:
                return PipelineReasons.PREREQUISITES.BYOK_MISSING;
            case ValidationErrorType.PLAN_LIMIT_EXCEEDED:
                // PLAN_LIMIT_EXCEEDED is only ever raised for a trial. It splits
                // two ways: credits genuinely exhausted (steer to BYOK — the
                // trial is still active), or the license service couldn't
                // confirm the credit (transient billing failure) — which must
                // not claim the reviews were used up, just ask to retry.
                if (subscriptionStatus === 'trial') {
                    return trialCreditsExhausted
                        ? PipelineReasons.PREREQUISITES.TRIAL_CREDITS_EXHAUSTED
                        : PipelineReasons.PREREQUISITES.LICENSE_UNAVAILABLE;
                }
                return PipelineReasons.PREREQUISITES.PLAN_LIMIT;
            case ValidationErrorType.USER_NOT_LICENSED:
                return PipelineReasons.PREREQUISITES.USER_NO_LICENSE;
            case ValidationErrorType.INVALID_LICENSE:
            default:
                return PipelineReasons.PREREQUISITES.NO_LICENSE;
        }
    }

    private async handleValidationFailure(
        context: CodeReviewPipelineContext,
        validationResult: any,
        showStatusFeedback: boolean,
    ): Promise<'auto_assigned' | 'failed'> {
        const {
            organizationAndTeamData,
            userGitId,
            repository,
            pullRequest,
            platformType,
            triggerCommentId,
        } = context;

        if (
            validationResult.errorType === ValidationErrorType.USER_NOT_LICENSED
        ) {
            const userPrs = await this.pullRequestsService.find({
                'organizationId': organizationAndTeamData.organizationId,
                'user.id': isNaN(Number(userGitId))
                    ? userGitId
                    : Number(userGitId),
            } as any);

            const autoAssignResult =
                await this.autoAssignLicenseUseCase.execute({
                    organizationAndTeamData,
                    userGitId: userGitId,
                    prNumber: pullRequest?.number,
                    prCount: userPrs?.length ?? 0,
                    repositoryName: repository?.name,
                    provider: platformType,
                });

            if (autoAssignResult.shouldProceed) {
                this.logger.log({
                    message: `Proceeding with review after auto-assign check: ${autoAssignResult.reason}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData,
                        userGitId,
                        reason: autoAssignResult.reason,
                    },
                });
                return 'auto_assigned';
            }

            this.logger.warn({
                message: 'User not licensed but company has licenses',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    prNumber: pullRequest?.number,
                    userGitId,
                    autoAssignReason: autoAssignResult.reason,
                },
            });

            const shouldAddReaction =
                autoAssignResult.reason !== 'IGNORED_USER' &&
                autoAssignResult.reason !== 'NOT_ALLOWED_USER';

            if (shouldAddReaction && showStatusFeedback) {
                await this.addNoLicenseReaction({
                    organizationAndTeamData,
                    repository,
                    prNumber: pullRequest.number,
                    platformType,
                    triggerCommentId,
                });
            }
        } else {
            let noActiveSubscriptionType: NoActiveSubscriptionType =
                validationResult.errorType
                    ? ERROR_TO_MESSAGE_TYPE[validationResult.errorType]
                    : 'general';

            // PLAN_LIMIT_EXCEEDED on a trial is one of two things: the
            // Kodus-paid reviews are genuinely used up (trial still active —
            // steer to BYOK, not "trial ended"), or the license service
            // couldn't confirm the credit (transient billing failure — say so
            // and ask to retry, never "used up" or "trial ended").
            if (
                validationResult.errorType ===
                    ValidationErrorType.PLAN_LIMIT_EXCEEDED &&
                validationResult.subscriptionStatus === 'trial'
            ) {
                noActiveSubscriptionType =
                    validationResult.metadata?.trialCreditsExhausted === true
                        ? 'trial_credits_exhausted'
                        : 'license_unavailable';
            }

            if (showStatusFeedback) {
                await this.createNoActiveSubscriptionComment({
                    organizationAndTeamData,
                    repository,
                    prNumber: pullRequest.number,
                    noActiveSubscriptionType,
                });
            }

            this.logger.warn({
                message: 'No active subscription found',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    prNumber: pullRequest.number,
                    userGitId,
                },
            });
        }

        return 'failed';
    }

    /**
     * Provision a missing trial for an org that finished onboarding but was
     * left without a license. Cloud-only, idempotent and best-effort: any
     * failure leaves the original INVALID_LICENSE result untouched so the
     * normal "no active subscription" handling still runs.
     *
     * Returns true when a trial is in place after the call (so the caller
     * should re-validate).
     */
    private async tryHealMissingTrial(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        try {
            if (!environment.API_CLOUD_MODE) {
                return false;
            }

            const { organizationAndTeamData } = context;

            const onboardingFinished = await this.hasFinishedOnboarding(
                organizationAndTeamData,
            );

            if (!onboardingFinished) {
                return false;
            }

            // "Is BYOK configured?" = did the run resolve a non-managed slot
            // for the codeReview task (v2 resolver). A null slot means the
            // env/managed default — no client BYOK — so the trial is
            // provisioned without one. resolveTaskSlot resolves without
            // building the model (no decrypt / SDK client), so only the slot's
            // presence is inspected here.
            const carrier =
                await this.permissionValidationService.resolveTaskSlot(
                    organizationAndTeamData,
                    LLM_TASK.codeReview,
                );

            const provisioned = await this.licenseService.startTrial(
                organizationAndTeamData,
                Boolean(carrier),
            );

            if (provisioned) {
                this.logger.log({
                    message:
                        'Auto-provisioned missing trial for onboarded org at review time',
                    context: this.stageName,
                    metadata: { organizationAndTeamData },
                });
            }

            return provisioned;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to auto-provision missing trial at review time',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return false;
        }
    }

    private async hasFinishedOnboarding(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const platformConfig = await this.parametersService.findByKey(
            ParametersKey.PLATFORM_CONFIGS,
            organizationAndTeamData,
        );

        return platformConfig?.configValue?.finishOnboard === true;
    }

    private async isShowStatusFeedbackEnabled(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        if (typeof context.codeReviewConfig?.showStatusFeedback === 'boolean') {
            return context.codeReviewConfig.showStatusFeedback;
        }

        try {
            const parameter = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                context.organizationAndTeamData,
            );

            const parameterConfig = parameter?.configValue as any;
            const repositoryConfig = parameterConfig?.repositories?.find(
                (repositoryConfig: any) =>
                    repositoryConfig?.id === context.repository?.id,
            );

            if (
                typeof repositoryConfig?.configs?.showStatusFeedback ===
                'boolean'
            ) {
                return repositoryConfig.configs.showStatusFeedback;
            }

            if (
                typeof parameterConfig?.configs?.showStatusFeedback ===
                'boolean'
            ) {
                return parameterConfig.configs.showStatusFeedback;
            }
        } catch (error) {
            this.logger.warn({
                message: 'Error resolving show status feedback config',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repositoryId: context.repository?.id,
                },
            });
        }

        return true;
    }

    private async isUserIgnored(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId?: string,
    ): Promise<boolean> {
        if (!userGitId) {
            return false;
        }

        const config = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            organizationAndTeamData,
        );

        const configValue =
            config?.configValue as OrganizationParametersAutoAssignConfig;

        if (
            Array.isArray(configValue?.allowedUsers) &&
            configValue.allowedUsers.length > 0 &&
            !configValue.allowedUsers.includes(userGitId)
        ) {
            return true;
        }

        if (
            configValue?.ignoredUsers?.length > 0 &&
            configValue?.ignoredUsers.includes(userGitId)
        ) {
            return true;
        }

        return false;
    }

    private async isCentralizedConfigRepositoryReviewDisabled(
        organizationAndTeamData: OrganizationAndTeamData,
        repository?: { id?: string; name?: string },
    ): Promise<boolean> {
        try {
            const centralizedConfigParameter =
                await this.parametersService.findByKey(
                    ParametersKey.CENTRALIZED_CONFIG,
                    organizationAndTeamData,
                );

            if (
                !centralizedConfigParameter ||
                !centralizedConfigParameter.configValue ||
                !centralizedConfigParameter.configValue.enabled
            ) {
                return false;
            }

            const centralizedConfigRepoId =
                centralizedConfigParameter.configValue.repository?.id;

            if (!centralizedConfigRepoId || !repository?.id) {
                return false;
            }

            if (repository.id === centralizedConfigRepoId) {
                this.logger.log({
                    message: 'Centralized config repository identified',
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData,
                        repositoryName: repository.name,
                        repositoryId: repository.id,
                    },
                });

                return true;
            }

            return false;
        } catch (error) {
            this.logger.warn({
                message:
                    'Error resolving centralized config repository review exclusion',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId: repository?.id,
                    repositoryName: repository?.name,
                },
            });
        }

        return false;
    }

    /**
     * A repository selected purely as a source of GLOBAL Kody Rules is a
     * config/data repository, not a codebase to review — mirror the
     * centralized-config behaviour and skip the automation for its PRs.
     */
    private async isGlobalRulesSourceRepositoryReviewDisabled(
        organizationAndTeamData: OrganizationAndTeamData,
        repository?: { id?: string; name?: string },
    ): Promise<boolean> {
        try {
            if (!repository?.id) {
                return false;
            }

            const globalRulesSourceParameter =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.GLOBAL_RULES_SOURCE_REPOSITORIES,
                    organizationAndTeamData,
                );

            const repositories =
                globalRulesSourceParameter?.configValue?.repositories;

            if (!Array.isArray(repositories) || repositories.length === 0) {
                return false;
            }

            const isSource = repositories.some(
                (r) => String(r?.id) === String(repository.id),
            );

            if (isSource) {
                this.logger.log({
                    message: 'Global Kody Rules source repository identified',
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData,
                        repositoryName: repository.name,
                        repositoryId: repository.id,
                    },
                });
            }

            return isSource;
        } catch (error) {
            this.logger.warn({
                message:
                    'Error resolving global Kody Rules source repository review exclusion',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData,
                    repositoryId: repository?.id,
                    repositoryName: repository?.name,
                },
            });
        }

        return false;
    }

    private async addNoLicenseReaction(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        prNumber: number;
        platformType: PlatformType;
        triggerCommentId?: string | number;
    }) {
        try {
            if (
                params.platformType === PlatformType.AZURE_REPOS ||
                params.platformType === PlatformType.BITBUCKET
            ) {
                const message =
                    '[👎](https://docs.kodus.io/how_to_use/en/code_review/flow#what-each-emoji-means)';
                if (
                    params.triggerCommentId &&
                    params.platformType === PlatformType.BITBUCKET
                ) {
                    await this.codeManagementService.createResponseToComment({
                        organizationAndTeamData: params.organizationAndTeamData,
                        repository: params.repository,
                        prNumber: params.prNumber,
                        inReplyToId:
                            typeof params.triggerCommentId === 'string'
                                ? parseInt(params.triggerCommentId, 10) ||
                                  params.triggerCommentId
                                : params.triggerCommentId,
                        body: message,
                    });
                } else {
                    await this.codeManagementService.createIssueComment({
                        organizationAndTeamData: params.organizationAndTeamData,
                        repository: params.repository,
                        prNumber: params.prNumber,
                        body: message,
                    });
                }
                return;
            }

            const reaction = NO_LICENSE_REACTION_MAP[params.platformType];
            if (!reaction) {
                return;
            }

            if (params.triggerCommentId) {
                await this.codeManagementService.addReactionToComment({
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    prNumber: params.prNumber,
                    commentId:
                        typeof params.triggerCommentId === 'string'
                            ? parseInt(params.triggerCommentId, 10)
                            : params.triggerCommentId,
                    reaction,
                });
            } else {
                await this.codeManagementService.addReactionToPR({
                    organizationAndTeamData: params.organizationAndTeamData,
                    repository: params.repository,
                    prNumber: params.prNumber,
                    reaction,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error adding no license reaction',
                context: this.stageName,
                error,
                metadata: {
                    ...params,
                },
            });
        }
    }

    private async createNoActiveSubscriptionComment(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        prNumber: number;
        noActiveSubscriptionType: NoActiveSubscriptionType;
    }) {
        if (params.noActiveSubscriptionType === 'no_error') {
            return;
        }

        let message = await this.noActiveSubscriptionGeneralMessage();

        if (params.noActiveSubscriptionType === 'user') {
            message = await this.noActiveSubscriptionForUser();
        } else if (params.noActiveSubscriptionType === 'byok_required') {
            message = await this.noBYOKConfiguredMessage();
        } else if (
            params.noActiveSubscriptionType === 'trial_credits_exhausted'
        ) {
            message = await this.trialCreditsExhaustedMessage();
        } else if (params.noActiveSubscriptionType === 'license_unavailable') {
            message = await this.licenseUnavailableMessage();
        }

        await this.codeManagementService.createIssueComment({
            organizationAndTeamData: params.organizationAndTeamData,
            repository: params.repository,
            prNumber: params?.prNumber,
            body: message,
        });

        this.logger.log({
            message: `No active subscription found for PR#${params?.prNumber}`,
            context: this.stageName,
            metadata: {
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.repository,
                prNumber: params?.prNumber,
            },
        });
    }

    private async noActiveSubscriptionGeneralMessage(): Promise<string> {
        return (
            '## Your trial has ended! 😢\n\n' +
            'To keep getting reviews, activate your plan [here](https://app.kodus.io/settings/subscription).\n\n' +
            'Got questions about plans or want to see if we can extend your trial? Talk to our founders [here](https://cal.com/gabrielmalinosqui/30min).😎\n\n' +
            '<!-- kody-codereview -->'
        );
    }

    private async trialCreditsExhaustedMessage(): Promise<string> {
        return (
            "## You've used all your free Kodus-paid PR reviews 🎁\n\n" +
            'Your trial is still active — this just means the PR reviews we ' +
            'cover during the trial are used up.\n\n' +
            '**[Connect your own AI key](https://app.kodus.io/organization/byok)** ' +
            'to keep Kody reviewing — unlimited reviews, on any plan (Free included).\n\n' +
            'Want more trial reviews to finish evaluating before adding a key? ' +
            '[Talk to our founders](https://cal.com/gabrielmalinosqui/30min). 😎\n\n' +
            '<!-- kody-codereview -->'
        );
    }

    private async licenseUnavailableMessage(): Promise<string> {
        return (
            "## Subscription check unavailable ⏳\n\n" +
            "We couldn't confirm your subscription right now — the license " +
            'service is temporarily unreachable.\n\n' +
            'Please re-run the review in a few minutes (or push a new commit) ' +
            "and Kody will pick it up.\n\n" +
            '<!-- kody-codereview -->'
        );
    }

    private async noActiveSubscriptionForUser(): Promise<string> {
        return (
            '## User License not found! 😢\n\n' +
            'To perform the review, ask the admin to add a subscription for your user in [subscription management](https://app.kodus.io/settings/subscription).\n\n' +
            '<!-- kody-codereview -->'
        );
    }

    private async noBYOKConfiguredMessage(): Promise<string> {
        return (
            '## BYOK Configuration Required! 🔑\n\n' +
            'Your plan requires a Bring Your Own Key (BYOK) configuration to perform code reviews.\n\n' +
            'Please configure your API keys in [Settings > BYOK Configuration](https://app.kodus.io/organization/byok).\n\n' +
            '<!-- kody-codereview -->'
        );
    }

    private async isAutomatedReviewActive(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        try {
            const parameter = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                context.organizationAndTeamData,
            );

            const parameterConfig = parameter?.configValue as any;
            const repositoryConfig = parameterConfig?.repositories?.find(
                (repo: any) => repo?.id === context.repository?.id,
            );

            if (
                typeof repositoryConfig?.configs?.automatedReviewActive ===
                'boolean'
            ) {
                return repositoryConfig.configs.automatedReviewActive;
            }

            if (
                typeof parameterConfig?.configs?.automatedReviewActive ===
                'boolean'
            ) {
                return parameterConfig.configs.automatedReviewActive;
            }
        } catch (error) {
            this.logger.warn({
                message: 'Error resolving automatedReviewActive config',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repositoryId: context.repository?.id,
                },
            });
        }

        return true;
    }

    private validatePrerequisites(
        context: CodeReviewPipelineContext,
    ): IStageValidationResult {
        const { pullRequest, repository } = context;

        if (!repository || !repository.id) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.PREREQUISITES.MISSING_DATA,
                    ),
                    reasonCode: AutomationMessage.VALIDATION_FAILED,
                },
            };
        }

        if (!pullRequest) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.PREREQUISITES.MISSING_DATA,
                    ),
                    reasonCode: AutomationMessage.VALIDATION_FAILED,
                },
            };
        }

        if (
            (pullRequest.state === 'closed' ||
                pullRequest.state === 'merged') &&
            context.origin !== 'command'
        ) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.PREREQUISITES.CLOSED,
                    ),
                    reasonCode: AutomationMessage.VALIDATION_FAILED,
                    metadata: {
                        prState: pullRequest.state,
                    },
                },
            };
        }

        if (pullRequest.locked) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.PREREQUISITES.LOCKED,
                    ),
                    reasonCode: AutomationMessage.VALIDATION_FAILED,
                    metadata: {
                        isLocked: true,
                    },
                },
            };
        }

        return { canProceed: true };
    }

    /**
     * Notify the PR author once that their PR was skipped because the
     * org has no active license. Rate-limited to one notification per
     * (author, org) per 24h via the shared cache layer so a contributor
     * opening dozens of PRs during an outage gets one notification, not
     * dozens. Best-effort: failures are swallowed.
     */
    private async notifySkippedNoLicense(
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        try {
            const { pullRequest, organizationAndTeamData, repository } =
                context;
            const author = pullRequest?.user as
                | {
                      email?: string;
                      username?: string;
                      login?: string;
                      nickname?: string;
                      uniqueName?: string;
                      descriptor?: string;
                  }
                | undefined;

            // Resolve the author handle with the SAME field precedence used to
            // persist `user.username` in the pullRequests collection
            // (PullRequestsService.extractUser), applied to the same
            // `pullRequest.user` object. Keeping these aligned guarantees the
            // notification shows exactly the handle we already store, for every
            // platform: GitHub `login`, GitLab/Bitbucket-DC `username`,
            // Bitbucket-Cloud `nickname`, Azure `uniqueName` (its UPN).
            const authorUsername =
                author?.login ||
                author?.username ||
                author?.nickname ||
                author?.uniqueName ||
                author?.descriptor ||
                undefined;

            const authorRecipient =
                await this.prAuthorRecipientResolver.resolve(
                    { email: author?.email, login: author?.username },
                    organizationAndTeamData.organizationId,
                );

            // Notify the PR author when they're a Kodus user; otherwise fall
            // back to the org owners so an external-contributor / bot PR still
            // alerts someone. Rate-limit per recipient target (the author, or
            // a single "owners" bucket) so a burst of PRs sends one alert.
            const recipients =
                authorRecipient != null && authorRecipient.kind === 'user'
                    ? authorRecipient
                    : recipientByRole(Role.OWNER);
            const rateLimitTarget =
                authorRecipient != null && authorRecipient.kind === 'user'
                    ? authorRecipient.userId
                    : 'owners';

            const rateLimitKey = `notif-rate:review_skipped_no_license:${rateLimitTarget}:${organizationAndTeamData.organizationId}`;
            const allowed = await this.notificationRateLimiter.shouldEmit(
                rateLimitKey,
                SKIPPED_NO_LICENSE_RATE_LIMIT_TTL_SECONDS,
            );
            if (!allowed) return;

            // Pick any active owner's email as the contact (best-effort).
            const owners = await this.usersService.find(
                {
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    role: Role.OWNER,
                },
                [STATUS.ACTIVE],
            );
            const ownerContact = owners?.[0]?.email;

            await this.notificationService.emit({
                event: NotificationEvent.REVIEW_SKIPPED_NO_LICENSE,
                payload: {
                    prUrl: (pullRequest?.url as string) ?? '',
                    repoName: repository?.name ?? '',
                    ownerContact,
                    authorUsername,
                },
                organizationId: organizationAndTeamData.organizationId,
                recipients,
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to emit review.skipped_no_license notification',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: this.stageName,
            });
        }
    }
}
