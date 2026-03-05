import { createLogger } from '@kodus/flow';
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
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

const ERROR_TO_MESSAGE_TYPE: Record<
    ValidationErrorType,
    'user' | 'general' | 'byok_required' | 'no_error'
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

        // Centralized permission validation
        const validationResult =
            await this.permissionValidationService.validateExecutionPermissions(
                organizationAndTeamData,
                userGitId,
                ValidatePrerequisitesStage.name,
            );

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
                    draft.codeReviewConfig.byokConfig =
                        validationResult.byokConfig;
                }
            });
        }

        // Validation failed
        const failureHandled = await this.handleValidationFailure(
            context,
            validationResult,
            showStatusFeedback,
        );

        if (failureHandled === 'auto_assigned') {
            return this.updateContext(context, (draft) => {
                applyShowStatusFeedbackMetadata(draft);
            });
        }

        return this.updateContext(context, (draft) => {
            applyShowStatusFeedbackMetadata(draft);
            draft.statusInfo = {
                status: AutomationStatus.SKIPPED, // Or FAILED? Usually SKIPPED if business logic prevents it.
                message: StageMessageHelper.skippedWithReason(
                    this.getLicenseSkipReason(validationResult.errorType),
                ),
            };

            // If we failed validation, we likely sent a specific license notification (for Azure/Bitbucket).
            // Mark it so the handler doesn't send a generic "Skipped" message on top.
            if (
                context.platformType === PlatformType.AZURE_REPOS ||
                context.platformType === PlatformType.BITBUCKET ||
                !showStatusFeedback
            ) {
                if (!draft.pipelineMetadata) {
                    draft.pipelineMetadata = {};
                }
                draft.pipelineMetadata.notificationHandled = true;
            }
        });
    }

    private getLicenseSkipReason(
        errorType?: ValidationErrorType,
    ): PipelineReason {
        switch (errorType) {
            case ValidationErrorType.BYOK_REQUIRED:
                return PipelineReasons.PREREQUISITES.BYOK_MISSING;
            case ValidationErrorType.PLAN_LIMIT_EXCEEDED:
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
                'user.id': userGitId,
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
            const noActiveSubscriptionType = validationResult.errorType
                ? ERROR_TO_MESSAGE_TYPE[validationResult.errorType]
                : 'general';

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
        noActiveSubscriptionType:
            | 'user'
            | 'general'
            | 'byok_required'
            | 'no_error';
    }) {
        if (params.noActiveSubscriptionType === 'no_error') {
            return;
        }

        let message = await this.noActiveSubscriptionGeneralMessage();

        if (params.noActiveSubscriptionType === 'user') {
            message = await this.noActiveSubscriptionForUser();
        } else if (params.noActiveSubscriptionType === 'byok_required') {
            message = await this.noBYOKConfiguredMessage();
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

        if (pullRequest.state === 'closed' || pullRequest.state === 'merged') {
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
}
