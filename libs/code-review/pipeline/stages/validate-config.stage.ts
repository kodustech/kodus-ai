import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { createLogger } from '@libs/core/log/logger';
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
import { routeCodeReviewModel } from './route-code-review-model';
import { resolveRiskReviewMode } from '@libs/code-review/domain/review-mode';
import {
    HEAVY_MODE_PLAN_REQUIRED,
    isHeavyModePlanAllowed,
} from '@libs/ee/heavy-mode/heavy-mode-plan';
import { unknownCustomAgentReply } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import {
    CUSTOM_AGENTS_BETA_REQUIRED,
    CUSTOM_AGENTS_PLAN_REQUIRED,
    customAgentsBlockedBy,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agents-plan';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { isPlatformFundedProvider } from '@libs/llm/platform-funded-provider';
import { KODUS_CREDITS_EXHAUSTED_COMMENT } from '@libs/core/infrastructure/pipeline/constants/pipeline-comments.const';

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
        private readonly permissionValidationService: PermissionValidationService,
        // Optional so specs that do not care about the plan still compile;
        // without it no custom agent and no heavy review runs (fail-closed
        // for the paid features).
        @Optional()
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService?: ILicenseService,
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

            // Custom agents and their skills and docs run on Teams and above
            // (#2172), and on a self-hosted install only with beta features
            // on (#2425). Otherwise the saved config is left as it is and
            // this review runs without it; `@kody -v` says why and stops.
            const customAgentsBlocker =
                context.onlyCustomAgent ||
                context.codeReviewConfig.customAgents?.length ||
                context.codeReviewConfig.knowledge?.length
                    ? await customAgentsBlockedBy(
                          this.licenseService,
                          context.organizationAndTeamData,
                          this.stageName,
                      )
                    : null;
            if (customAgentsBlocker) {
                const byBeta = customAgentsBlocker === 'beta';
                if (context.onlyCustomAgent) {
                    await this.replyToReviewCommand(
                        context,
                        `\`@kody -v ${context.onlyCustomAgent}\` did not run. ${
                            byBeta
                                ? CUSTOM_AGENTS_BETA_REQUIRED
                                : CUSTOM_AGENTS_PLAN_REQUIRED
                        }`,
                    );
                    return this.updateContext(context, (draft) => {
                        draft.statusInfo = {
                            status: AutomationStatus.SKIPPED,
                            message: byBeta
                                ? AutomationMessage.CUSTOM_AGENTS_BETA_REQUIRED
                                : AutomationMessage.CUSTOM_AGENTS_PLAN_REQUIRED,
                        };
                    });
                }
                this.logger.log({
                    message: byBeta
                        ? 'customAgents configured but BETA_FEATURES is off on this self-hosted install — custom agents disabled'
                        : 'customAgents configured but plan is not Teams/Enterprise — custom agents disabled',
                    context: this.stageName,
                    metadata: {
                        prNumber: context.pullRequest?.number,
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        configuredCount:
                            context.codeReviewConfig.customAgents?.length ?? 0,
                    },
                });
                context = this.updateContext(context, (draft) => {
                    draft.codeReviewConfig.customAgents = [];
                    draft.codeReviewConfig.knowledge = [];
                });
            }

            // `@kody -v <slug>` naming no agent would run an empty review;
            // answer on the PR with the agents there are, and stop.
            if (context.onlyCustomAgent) {
                const reply = unknownCustomAgentReply(
                    context.codeReviewConfig.customAgents,
                    context.onlyCustomAgent,
                );
                if (reply) {
                    await this.replyToReviewCommand(context, reply);
                    return this.updateContext(context, (draft) => {
                        draft.statusInfo = {
                            status: AutomationStatus.SKIPPED,
                            message: AutomationMessage.UNKNOWN_CUSTOM_AGENT,
                        };
                    });
                }
            }

            // Shared risk must be known before selecting the review model.
            // The early cadence/access checks still run before paying for it.
            if (context.codeReviewConfig.riskAssessmentActive !== true) {
                context = await this.resolveReviewRouting(context);
                if (context.statusInfo?.status === AutomationStatus.SKIPPED)
                    return context;
            }

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

    /** Re-resolve after shared risk; the same plan and credit gates still apply. */
    async resolveReviewRouting(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const byokConfig = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.BYOK_CONFIG,
            context.organizationAndTeamData,
        );

        // The mode the command asked for, else the one in settings. Heavy
        // runs on Teams and Enterprise only; elsewhere the review runs
        // Balanced, and a command that asked for heavy is told why.
        const heavy =
            resolveRiskReviewMode({
                requested: context.requestedReviewMode,
                configured: context.codeReviewConfig?.reviewMode,
                routing: context.codeReviewConfig?.riskReviewRouting,
                risk: context.riskAssessment,
                currentHeadSha: context.pullRequest.head?.sha ?? '',
                heavyAllowed: true,
            }) === 'heavy' && (await this.heavyModeAllowed(context));

        // The review's routed slot, or none → the env/managed default
        // resolves downstream, matching a missing config.
        const routed = routeCodeReviewModel(
            byokConfig?.configValue,
            context.codeReviewConfig,
            heavy,
        );
        if (routed.blocked) {
            this.logger.warn({
                message: `BYOK routing BLOCKED for ${heavy ? 'codeReviewHeavy' : 'codeReview'} — falling back to env/managed default: ${routed.reason}`,
                context: this.stageName,
                metadata: {
                    prNumber: context?.pullRequest?.number,
                    repositoryName: context?.repository?.name,
                    organizationAndTeamData: context?.organizationAndTeamData,
                },
            });
        }

        if (
            await this.routedKodusCreditsExhausted(
                context,
                byokConfig?.configValue,
                routed.resolvedModelSlot,
                heavy,
            )
        ) {
            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.PREREQUISITES.CREDITS_EXHAUSTED,
                    ),
                };
                if (!draft.pipelineMetadata) {
                    draft.pipelineMetadata = {};
                }
                draft.pipelineMetadata.notificationHandled = true;
            });
        }

        context = this.updateContext(context, (draft) => {
            draft.heavy = heavy;
            // Materialize the routed model into the resolved slot the pipeline
            // threads downstream (the handle stages read their limit/telemetry
            // metadata off).
            draft.codeReviewConfig.resolvedModelSlot = routed.resolvedModelSlot;
            draft.codeReviewConfig.byokConfig = routed.resolvedModelSlot;
        });
        return context;
    }

    /**
     * The prerequisites gated the credits of the organization's `codeReview`
     * model, before the review mode and the repository's model override were
     * known. When the model this review runs on (the Heavy one, or a
     * repository override) is routed by Kodus and that one is not, nothing
     * checked the balance yet; when both are, it already was. Posts the same
     * comment the prerequisites post.
     */
    private async routedKodusCreditsExhausted(
        context: CodeReviewPipelineContext,
        storedConfig: unknown,
        routedSlot: CodeReviewConfig['resolvedModelSlot'],
        heavy: boolean,
    ): Promise<boolean> {
        if (!isPlatformFundedProvider(routedSlot?.provider)) {
            return false;
        }
        const gatedSlot = routeCodeReviewModel(
            storedConfig,
            {},
            false,
        ).resolvedModelSlot;
        if (isPlatformFundedProvider(gatedSlot?.provider)) {
            return false;
        }
        const gate =
            await this.permissionValidationService.gateKodusCreditsForSlot(
                routedSlot,
                context.organizationAndTeamData,
                this.stageName,
            );
        if (!gate) {
            return false;
        }

        this.logger.warn({
            message:
                'Kodus credits exhausted for the model this review runs on — review skipped',
            context: this.stageName,
            metadata: {
                organizationAndTeamData: context.organizationAndTeamData,
                prNumber: context.pullRequest?.number,
                repositoryId: context.repository?.id,
                heavy,
                model: routedSlot?.model,
            },
        });
        if (context.pipelineMetadata?.showStatusFeedback !== false) {
            await this.codeManagementService.createIssueComment({
                organizationAndTeamData: context.organizationAndTeamData,
                repository: context.repository,
                prNumber: context.pullRequest?.number,
                body: KODUS_CREDITS_EXHAUSTED_COMMENT,
            });
        }
        return true;
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

    private async heavyModeAllowed(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        if (
            await isHeavyModePlanAllowed(
                this.licenseService,
                context.organizationAndTeamData,
                this.stageName,
            )
        ) {
            return true;
        }
        const askedByCommand = context.requestedReviewMode === 'heavy';
        this.logger.log({
            message:
                'Heavy mode asked on a plan that is not Teams/Enterprise — the review runs Balanced',
            context: this.stageName,
            metadata: {
                organizationAndTeamData: context.organizationAndTeamData,
                prNumber: context.pullRequest?.number,
                repositoryId: context.repository?.id,
                askedByCommand,
            },
        });
        if (askedByCommand) {
            await this.replyToReviewCommand(context, HEAVY_MODE_PLAN_REQUIRED);
        }
        return false;
    }

    private async replyToReviewCommand(
        context: CodeReviewPipelineContext,
        body: string,
    ): Promise<void> {
        try {
            await this.codeManagementService.createSingleIssueComment({
                organizationAndTeamData: context.organizationAndTeamData,
                repository: context.repository,
                prNumber: context.pullRequest.number,
                body,
            });
        } catch (error) {
            this.logger.error({
                message: `Failed to reply to the review command on PR #${context.pullRequest?.number}`,
                context: ValidateConfigStage.name,
                error,
                metadata: {
                    onlyCustomAgent: context.onlyCustomAgent,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    repositoryId: context.repository?.id,
                    prNumber: context.pullRequest?.number,
                },
            });
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
        // A missing/corrupt list means we have no scope to enforce, so we let the
        // review through. An empty list is a real configuration: it narrows the
        // scope to the repository default branch, which mergeBaseBranches injects
        // below. Collapsing the two is what made every base branch reviewable.
        if (!configBaseBranches || !Array.isArray(configBaseBranches)) {
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

        const reason = configBaseBranches.length
            ? `Target branch '${targetBranch}' does not match configured patterns: [${expression}]`
            : `Target branch '${targetBranch}' is not the repository default branch, and no base branches are configured`;

        return {
            canProceed: false,
            details: {
                message: StageMessageHelper.skippedWithReason(
                    PipelineReasons.CONFIG.BRANCH_MISMATCH,
                    reason,
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
