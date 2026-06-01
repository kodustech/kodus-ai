import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { IStageValidationResult } from '@libs/core/infrastructure/pipeline/interfaces/stage-result.interface';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { createLogger } from '@kodus/flow';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import {
    OrganizationParametersKey,
    PlatformType,
} from '@libs/core/domain/enums';
import {
    AutomaticReviewStatus,
    CodeReviewConfig,
    ReviewCadenceState,
    ReviewCadenceType,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import {
    mergeBaseBranches,
    processExpression,
    shouldReviewBranches,
} from '@libs/code-review/infrastructure/adapters/services/branchReview.service';

@Injectable()
export class ValidateConfigStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'ValidateConfigStage';
    readonly label = 'Validating Configuration';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(ValidateConfigStage.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private automationExecutionService: IAutomationExecutionService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private organizationParametersService: IOrganizationParametersService,
        private codeManagementService: CodeManagementService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        try {
            if (!context.codeReviewConfig) {
                this.logger.error({
                    message: 'No config found in context',
                    context: this.stageName,
                    metadata: {
                        prNumber: context?.pullRequest?.number,
                        repositoryName: context?.repository?.name,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.statusInfo = {
                        status: AutomationStatus.SKIPPED,
                        message: AutomationMessage.NO_CONFIG_IN_CONTEXT,
                    };
                });
            }

            //TODO: revisar logica
            const byokConfig =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.BYOK_CONFIG,
                    context.organizationAndTeamData,
                );

            context = this.updateContext(context, (draft) => {
                const resolved = byokConfig?.configValue;
                draft.codeReviewConfig.byokConfig = resolved;

                // The merged code review config can override which BYOK *main*
                // model runs the review (directory -> repository -> BYOK
                // settings). An empty/absent value means "inherit", so the
                // BYOK-settings main model is left in place.
                const overrideModel = draft.codeReviewConfig.byokModel?.trim();
                if (resolved?.main && overrideModel) {
                    draft.codeReviewConfig.byokConfig = {
                        ...resolved,
                        main: { ...resolved.main, model: overrideModel },
                    };
                }
            });

            const cadenceResult = await this.evaluateReviewCadence(context);

            if (!cadenceResult.shouldProcess) {
                this.logger.warn({
                    message: cadenceResult.reason,
                    serviceName: ValidateConfigStage.name,
                    context: this.stageName,
                    metadata: {
                        prNumber: context?.pullRequest?.number,
                        repositoryName: context?.repository?.name,
                        id: context?.repository?.id,
                        organizationAndTeamData:
                            context?.organizationAndTeamData,
                        reviewCadence:
                            context.codeReviewConfig?.reviewCadence?.type ||
                            ReviewCadenceType.AUTOMATIC,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.statusInfo = {
                        status: AutomationStatus.SKIPPED,
                        message: cadenceResult.reason,
                    };

                    if (cadenceResult.shouldSaveSkipped) {
                        draft.automaticReviewStatus =
                            cadenceResult.automaticReviewStatus;
                    }
                });
            }

            return this.updateContext(context, (draft) => {
                draft.automaticReviewStatus =
                    cadenceResult.automaticReviewStatus;
            });
        } catch (error) {
            this.logger.error({
                message: `Error in ValidateConfigStage for PR#${context?.pullRequest?.number}`,
                error,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                    repositoryId: context?.repository?.id,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: AutomationMessage.CONFIG_VALIDATION_ERROR,
                };
            });
        }
    }

    private async evaluateReviewCadence(
        context: CodeReviewPipelineContext,
    ): Promise<{
        shouldProcess: boolean;
        reason: string;
        shouldSaveSkipped: boolean;
        automaticReviewStatus?: AutomaticReviewStatus;
    }> {
        const config = context.codeReviewConfig!;

        // Validações básicas primeiro
        const basicValidation = this.shouldExecuteReview(
            context.pullRequest.title,
            context.pullRequest.base.ref, // TARGET (base branch - para onde vai o PR)
            context.pullRequest.head.ref, // SOURCE (head branch - de onde vem o PR)
            context.pullRequest.isDraft,
            config,
            context.origin || '',
            context.platformType,
            context.organizationAndTeamData,
            config.baseBranchDefault, // API base branch from repository
        );

        if (!basicValidation.canProceed) {
            const message =
                basicValidation.details?.message ||
                AutomationMessage.SKIPPED_BY_BASIC_RULES;

            return {
                shouldProcess: false,
                reason: message,
                shouldSaveSkipped: false,
            };
        }

        const cadenceType =
            config?.reviewCadence?.type || ReviewCadenceType.AUTOMATIC;

        // Se é comando manual (regular ou --force), sempre processa
        if (context.origin?.startsWith('command')) {
            const currentStatus = await this.getCurrentPRStatus(context);

            const automaticReviewStatus: AutomaticReviewStatus = {
                previousStatus: currentStatus,
                currentStatus: ReviewCadenceState.COMMAND,
                reasonForChange: 'Review triggered by start-review command',
            };

            return {
                shouldProcess: true,
                reason: AutomationMessage.PROCESSING_MANUAL,
                shouldSaveSkipped: false,
                automaticReviewStatus,
            };
        }

        // Lógica específica por tipo de cadência
        switch (cadenceType) {
            case ReviewCadenceType.AUTOMATIC:
                return await this.handleAutomaticMode(context);

            case ReviewCadenceType.MANUAL:
                return await this.handleManualMode(context);

            case ReviewCadenceType.AUTO_PAUSE:
                return await this.handleAutoPauseMode(context, config);

            default:
                return await this.handleAutomaticMode(context);
        }
    }

    private async handleAutomaticMode(
        context: CodeReviewPipelineContext,
    ): Promise<{
        shouldProcess: boolean;
        reason: string;
        shouldSaveSkipped: boolean;
        automaticReviewStatus?: AutomaticReviewStatus;
    }> {
        return {
            shouldProcess: true,
            reason: AutomationMessage.PROCESSING_AUTOMATIC,
            shouldSaveSkipped: false,
            automaticReviewStatus: {
                previousStatus: ReviewCadenceState.AUTOMATIC,
                currentStatus: ReviewCadenceState.AUTOMATIC,
            },
        };
    }

    private async handleManualMode(
        context: CodeReviewPipelineContext,
    ): Promise<{
        shouldProcess: boolean;
        reason: string;
        shouldSaveSkipped: boolean;
        automaticReviewStatus?: AutomaticReviewStatus;
    }> {
        const hasExistingReview =
            await this.hasExistingSuccessfulReview(context);

        if (!hasExistingReview) {
            return {
                shouldProcess: true,
                reason: AutomationMessage.FIRST_REVIEW_MANUAL,
                shouldSaveSkipped: false,
                automaticReviewStatus: {
                    previousStatus: ReviewCadenceState.AUTOMATIC,
                    currentStatus: ReviewCadenceState.AUTOMATIC,
                },
            };
        }

        const currentStatus = await this.getCurrentPRStatus(context);

        return {
            shouldProcess: false,
            reason: AutomationMessage.MANUAL_REQUIRED_TO_START,
            shouldSaveSkipped: true,
            automaticReviewStatus: {
                previousStatus: currentStatus,
                currentStatus: ReviewCadenceState.PAUSED,
            },
        };
    }

    private async handleAutoPauseMode(
        context: CodeReviewPipelineContext,
        config: any,
    ): Promise<{
        shouldProcess: boolean;
        reason: string;
        shouldSaveSkipped: boolean;
        automaticReviewStatus?: AutomaticReviewStatus;
    }> {
        const hasExistingReview =
            await this.hasExistingSuccessfulReview(context);

        if (!hasExistingReview) {
            return {
                shouldProcess: true,
                reason: AutomationMessage.FIRST_REVIEW_AUTO_PAUSE,
                shouldSaveSkipped: false,
                automaticReviewStatus: {
                    previousStatus: ReviewCadenceState.AUTOMATIC,
                    currentStatus: ReviewCadenceState.AUTOMATIC,
                },
            };
        }

        const currentStatus = await this.getCurrentPRStatus(context);
        if (currentStatus === ReviewCadenceState.PAUSED) {
            return {
                shouldProcess: false,
                reason: AutomationMessage.PR_PAUSED_NEED_RESUME,
                shouldSaveSkipped: true,
                automaticReviewStatus: {
                    previousStatus: ReviewCadenceState.PAUSED,
                    currentStatus: ReviewCadenceState.PAUSED,
                },
            };
        }

        const shouldPause = await this.shouldPauseForBurst(context, config);

        if (shouldPause) {
            const pauseCommentId = await this.createPauseComment(context);

            return {
                shouldProcess: false,
                reason: AutomationMessage.PR_PAUSED_BURST_PUSHES,
                shouldSaveSkipped: true,
                automaticReviewStatus: {
                    previousStatus: ReviewCadenceState.AUTOMATIC,
                    currentStatus: ReviewCadenceState.PAUSED,
                    reasonForChange:
                        'Multiple pushes detected in short time window',
                    pauseCommentId: pauseCommentId || undefined,
                },
            };
        }

        return {
            shouldProcess: true,
            reason: AutomationMessage.PROCESSING_AUTO_PAUSE,
            shouldSaveSkipped: false,
            automaticReviewStatus: {
                previousStatus: ReviewCadenceState.AUTOMATIC,
                currentStatus: ReviewCadenceState.AUTOMATIC,
            },
        };
    }

    private async hasExistingSuccessfulReview(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        const executions =
            await this.automationExecutionService.findLatestExecutionByFilters({
                status: AutomationStatus.SUCCESS,
                teamAutomation: { uuid: context.teamAutomationId },
                pullRequestNumber: context.pullRequest.number,
                repositoryId: context?.repository?.id,
            });

        return !!executions;
    }

    private async getCurrentPRStatus(
        context: CodeReviewPipelineContext,
    ): Promise<ReviewCadenceState> {
        const latestExecution =
            await this.automationExecutionService.findLatestExecutionByFilters({
                teamAutomation: { uuid: context.teamAutomationId },
                pullRequestNumber: context.pullRequest.number,
                repositoryId: context?.repository?.id,
            });

        if (!latestExecution?.dataExecution?.automaticReviewStatus) {
            return ReviewCadenceState.AUTOMATIC;
        }

        return (
            latestExecution.dataExecution.automaticReviewStatus.currentStatus ||
            ReviewCadenceState.AUTOMATIC
        );
    }

    private async shouldPauseForBurst(
        context: CodeReviewPipelineContext,
        config: any,
    ): Promise<boolean> {
        if (context.dryRun?.enabled) {
            return false;
        }

        const pushesToTrigger = config.reviewCadence?.pushesToTrigger || 3;
        const timeWindowMinutes = config.reviewCadence?.timeWindow || 15;

        const timeWindowStart = new Date();
        timeWindowStart.setMinutes(
            timeWindowStart.getMinutes() - timeWindowMinutes,
        );

        const recentExecutions = await this.getRecentSuccessfulExecutions(
            context,
            timeWindowStart,
        );

        return recentExecutions.length >= pushesToTrigger;
    }

    private async getRecentSuccessfulExecutions(
        context: CodeReviewPipelineContext,
        since: Date,
    ): Promise<any[]> {
        try {
            const now = new Date();
            const executions =
                await this.automationExecutionService.findByPeriodAndTeamAutomationId(
                    since,
                    now,
                    context.teamAutomationId,
                );

            if (
                !executions ||
                !context?.repository?.id ||
                !context?.pullRequest?.number
            ) {
                return [];
            }

            return executions?.filter(
                (execution) =>
                    execution.status === AutomationStatus.SUCCESS &&
                    execution.pullRequestNumber ===
                        context.pullRequest.number &&
                    execution.repositoryId === context?.repository?.id,
            );
        } catch (error) {
            this.logger.error({
                message: `Failed to get recent executions for PR #${context.pullRequest.number}`,
                context: ValidateConfigStage.name,
                error,
            });
            return [];
        }
    }

    private async createPauseComment(
        context: CodeReviewPipelineContext,
    ): Promise<string | null> {
        try {
            const commentBody =
                "Auto-paused – comment @kody start-review when you're ready.";

            const comment =
                await this.codeManagementService.createSingleIssueComment({
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository,
                    prNumber: context.pullRequest.number,
                    body: commentBody,
                });

            return comment?.id || null;
        } catch (error) {
            this.logger.error({
                message: `Failed to create pause comment for PR #${context.pullRequest.number}`,
                context: ValidateConfigStage.name,
                error,
            });
            return null;
        }
    }

    private shouldExecuteReview(
        title: string,
        targetBranch: string, // TARGET (base branch - para onde vai o PR)
        sourceBranch: string, // SOURCE (head branch - de onde vem o PR)
        isDraft: boolean,
        config: CodeReviewConfig,
        origin: string,
        platformType: PlatformType,
        organizationAndTeamData: OrganizationAndTeamData,
        apiBaseBranch?: string,
    ): IStageValidationResult {
        if (origin?.startsWith('command')) {
            return { canProceed: true };
        }

        const {
            automatedReviewActive,
            ignoredTitleKeywords,
            baseBranches,
            runOnDraft,
        } = config || {};

        if (!automatedReviewActive) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.CONFIG.DISABLED,
                    ),
                    reasonCode: AutomationMessage.SKIPPED_BY_BASIC_RULES,
                },
            };
        }

        const lowerTitle = title?.toLowerCase() || '';
        if (
            ignoredTitleKeywords?.some((keyword) =>
                lowerTitle.includes(keyword.toLowerCase()),
            )
        ) {
            const matchedKeyword = ignoredTitleKeywords.find((keyword) =>
                lowerTitle.includes(keyword.toLowerCase()),
            );
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.CONFIG.IGNORED_TITLE,
                        `Title matches ignored keyword: "${matchedKeyword}"`,
                    ),
                    reasonCode: AutomationMessage.SKIPPED_BY_BASIC_RULES,
                },
            };
        }

        const branchValidation = this._isBranchLogicValid(
            sourceBranch,
            targetBranch,
            baseBranches,
            apiBaseBranch,
            platformType,
            organizationAndTeamData,
        );

        if (!branchValidation.canProceed) {
            return branchValidation;
        }

        if (isDraft && !runOnDraft) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.CONFIG.DRAFT,
                        'runOnDraft=false',
                    ),
                    reasonCode: AutomationMessage.SKIPPED_BY_BASIC_RULES,
                },
            };
        }

        return { canProceed: true };
    }

    private _isBranchLogicValid(
        sourceBranch: string,
        targetBranch: string,
        configBaseBranches: string[] | undefined,
        apiBaseBranch: string | undefined,
        platformType: PlatformType,
        organizationAndTeamData: OrganizationAndTeamData,
    ): IStageValidationResult {
        if (
            !configBaseBranches ||
            !Array.isArray(configBaseBranches) ||
            configBaseBranches.length === 0
        ) {
            return { canProceed: true };
        }

        const mergedBranches = mergeBaseBranches(
            configBaseBranches,
            apiBaseBranch || targetBranch,
        );

        const normalizedBranches = this.normalizeBranchesForPlatform(
            mergedBranches,
            platformType,
        );

        const expression = normalizedBranches.join(', ');
        const reviewConfig = processExpression(expression);

        const isValid = shouldReviewBranches(
            sourceBranch,
            targetBranch,
            reviewConfig,
        );

        this.logger.log({
            message: 'Branch Review Validation',
            context: 'ValidateConfigStage',
            metadata: {
                originalConfig: configBaseBranches,
                apiBaseBranch,
                mergedBranches,
                expression,
                sourceBranch,
                targetBranch,
                reviewConfig,
                result: isValid ? 'REVIEW' : 'NO_REVIEW',
                organizationAndTeamData,
            },
        });

        if (isValid) {
            return { canProceed: true };
        }

        return {
            canProceed: false,
            details: {
                message: StageMessageHelper.skippedWithReason(
                    PipelineReasons.CONFIG.BRANCH_MISMATCH,
                    `Target branch '${targetBranch}' does not match configured patterns: [${expression}]`,
                ),
                reasonCode: AutomationMessage.SKIPPED_BY_BASIC_RULES,
            },
        };
    }

    /**
     * Normalizes branch patterns for different platforms
     * Azure DevOps adds refs/heads/ prefix to all branches
     * This method adds the prefix to user-configured patterns for compatibility
     */
    private normalizeBranchesForPlatform(
        branches: string[],
        platformType: PlatformType,
    ): string[] {
        if (platformType !== PlatformType.AZURE_REPOS) {
            return branches;
        }

        return branches.map((branch) => {
            if (branch.startsWith('refs/heads/')) {
                return branch;
            }

            if (branch.startsWith('!')) {
                const pattern = branch.slice(1);
                if (pattern.startsWith('refs/heads/')) {
                    return branch;
                }
                return `!refs/heads/${pattern}`;
            }

            if (branch.startsWith('=')) {
                const pattern = branch.slice(1);
                if (pattern.startsWith('refs/heads/')) {
                    return branch;
                }
                return `=refs/heads/${pattern}`;
            }

            if (branch.startsWith('contains:')) {
                return branch;
            }

            return `refs/heads/${branch}`;
        });
    }
}
