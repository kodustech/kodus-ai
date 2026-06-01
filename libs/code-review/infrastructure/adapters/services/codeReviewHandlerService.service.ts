/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    ForgejoReaction,
    GitHubReaction,
    GitlabReaction,
    Reaction,
    ReviewStatusReaction,
} from '@libs/code-review/domain/codeReviewFeedback/enums/codeReviewCommentReaction.enum';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PipelineFactory } from '@libs/core/infrastructure/pipeline/services/pipeline-factory.service';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

@Injectable()
export class CodeReviewHandlerService {
    private readonly logger = createLogger(CodeReviewHandlerService.name);

    private readonly reactionMap = {
        [PlatformType.GITHUB]: {
            [ReviewStatusReaction.START]: GitHubReaction.ROCKET,
            [ReviewStatusReaction.SUCCESS]: GitHubReaction.HOORAY,
            [ReviewStatusReaction.ERROR]: GitHubReaction.CONFUSED,
            [ReviewStatusReaction.SKIP]: GitHubReaction.EYES,
        },
        [PlatformType.GITLAB]: {
            [ReviewStatusReaction.START]: GitlabReaction.ROCKET,
            [ReviewStatusReaction.SUCCESS]: GitlabReaction.TADA,
            [ReviewStatusReaction.ERROR]: GitlabReaction.CONFUSED,
            [ReviewStatusReaction.SKIP]: GitlabReaction.EYES,
        },
        [PlatformType.FORGEJO]: {
            [ReviewStatusReaction.START]: ForgejoReaction.ROCKET,
            [ReviewStatusReaction.SUCCESS]: ForgejoReaction.HOORAY,
            [ReviewStatusReaction.ERROR]: ForgejoReaction.CONFUSED,
            [ReviewStatusReaction.SKIP]: ForgejoReaction.EYES,
        },
    };

    private readonly statusToCommentMap = {
        [ReviewStatusReaction.ERROR]:
            '[😕](https://docs.kodus.io/how_to_use/en/code_review/flow#what-each-emoji-means)',
        [ReviewStatusReaction.SKIP]:
            '[👀](https://docs.kodus.io/how_to_use/en/code_review/flow#what-each-emoji-means)',
    };

    constructor(
        @Inject('PIPELINE_PROVIDER')
        private readonly pipelineFactory: PipelineFactory<CodeReviewPipelineContext>,
        private readonly codeManagement: CodeManagementService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly telemetry: TelemetryService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
    ) {}

    /**
     * Atomic-ish "first review" claim per organization. Reads the
     * `FIRST_REVIEW_AT` parameter and only fires telemetry + writes the
     * marker if no prior marker exists. A rare race between two concurrent
     * first reviews could fire the event twice — acceptable for a once-per-
     * org-lifetime milestone.
     */
    private async captureFirstReviewIfNeeded(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id?: string; name?: string },
        pullRequestNumber: number | undefined,
        platformType: string,
    ): Promise<void> {
        const { organizationId, teamId } = organizationAndTeamData;
        if (!organizationId) return;

        try {
            const existing =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.FIRST_REVIEW_AT,
                    { organizationId },
                );
            if (existing) return;

            await this.organizationParametersService.createOrUpdateConfig(
                OrganizationParametersKey.FIRST_REVIEW_AT,
                new Date().toISOString(),
                { organizationId },
            );

            // Best-effort hydration: org name + owner email/name make the
            // milestone notification actionable (Discord/email). If any
            // lookup fails we still fire telemetry with whatever we have —
            // the milestone marker is the source of truth, names are gravy.
            const [org, owner] = await Promise.all([
                this.organizationService
                    .findOne({ uuid: organizationId })
                    .catch(() => undefined),
                this.usersService
                    .findOne({
                        organization: { uuid: organizationId },
                        role: Role.OWNER,
                    } as any)
                    .catch(() => undefined),
            ]);

            await this.telemetry.firstReviewCompleted({
                organizationId,
                organizationName: org?.name,
                teamId,
                repositoryId: repository?.id,
                repositoryName: repository?.name,
                pullRequestNumber,
                platform: platformType,
                ownerEmail: owner?.email,
                ownerId: owner?.uuid,
            });
        } catch (error) {
            this.logger.warn({
                message: 'Failed to capture first-review milestone',
                context: CodeReviewHandlerService.name,
                metadata: {
                    organizationId,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
        }
    }

    async handlePullRequest(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: any,
        branch: string,
        pullRequest: any,
        platformType: string,
        teamAutomationId: string,
        origin: string,
        action: string,
        executionId: string,
        triggerCommentId?: number | string,
        userGitId?: string,
        workflowJobId?: string, // Optional: ID of workflow job (for pausing/resuming)
        lastExecutionData?: any, // Data from the last successful execution
        correlationId?: string,
        // Parent (job-level) AbortSignal — forwarded from the strategy
        // which got it from runCodeReview use-case, originally created by
        // JobProcessorRouterService.runWithTimeout. When this aborts, all
        // downstream LLM/agent calls cancel via parentSignal composition.
        parentSignal?: AbortSignal,
    ) {
        let initialContext: CodeReviewPipelineContext;

        try {
            initialContext = {
                correlationId,
                workflowJobId,
                parentSignal,
                dryRun: {
                    enabled: false,
                },
                statusInfo: {
                    status: AutomationStatus.IN_PROGRESS,
                    message: 'Pipeline started',
                },
                pipelineVersion: '1.0.1',
                errors: [],
                organizationAndTeamData,
                repository,
                pullRequest,
                branch,
                teamAutomationId,
                origin,
                action,
                platformType: platformType as PlatformType,
                triggerCommentId,
                userGitId,
                pipelineMetadata: {
                    lastExecution: {
                        ...(lastExecutionData || null),
                        uuid: executionId,
                    },
                },
                preparedFileContexts: [],
                validSuggestions: [],
                discardedSuggestions: [],
                lastAnalyzedCommit: null,
                validSuggestionsByPR: [],
                validCrossFileSuggestions: [],
                externalPromptContext: {},
                externalPromptLayers: undefined,
            };

            // Add START reaction before pipeline
            await this.addStatusReaction(
                initialContext,
                ReviewStatusReaction.START,
            );

            const pipeline =
                this.pipelineFactory.getPipeline('CodeReviewPipeline');
            const result = await pipeline.execute(initialContext);

            // Classify the final status BEFORE reactions/logs so the right
            // emoji (hooray vs confused) and the persisted automation status
            // reflect reality. Errors with `severity === 'partial'` come from
            // auxiliary stages (business-logic validation, PR-level comments,
            // summary) or the kody-rules agent — they degrade the run but do
            // not kill it. Critical errors (default) flip the whole execution
            // to ERROR. Previously, a pipeline that finished in IN_PROGRESS
            // with agent failures was silently relabeled as SUCCESS here.
            const collectedErrors = result.errors || [];
            const hasCriticalError = collectedErrors.some(
                (e) => (e.severity ?? 'critical') === 'critical',
            );
            const hasPartialError = collectedErrors.some(
                (e) => e.severity === 'partial',
            );

            // `result.statusInfo` is frozen by immer — build a new object and
            // produce a shallow-cloned result that the rest of the function
            // (handleReactionsByStatus, logs, return value) can read.
            let classifiedStatus = result.statusInfo;
            if (classifiedStatus.status === AutomationStatus.IN_PROGRESS) {
                if (hasCriticalError) {
                    classifiedStatus = {
                        ...classifiedStatus,
                        status: AutomationStatus.ERROR,
                        message:
                            classifiedStatus.message ||
                            'Code review failed: one or more critical stages did not complete.',
                    };
                } else if (hasPartialError) {
                    classifiedStatus = {
                        ...classifiedStatus,
                        status: AutomationStatus.PARTIAL_ERROR,
                        message:
                            classifiedStatus.message ||
                            'Code review completed with warnings: one or more auxiliary stages failed.',
                    };
                } else {
                    classifiedStatus = {
                        ...classifiedStatus,
                        status: AutomationStatus.SUCCESS,
                        message: 'Code review completed successfully',
                    };
                }
            }

            const classifiedResult: CodeReviewPipelineContext = {
                ...result,
                statusInfo: classifiedStatus,
            };

            // Handle reactions based on classified result status
            await this.handleReactionsByStatus(initialContext, classifiedResult);

            this.logger.log({
                message: `Code review pipeline completed for PR#${pullRequest.number} with status=${classifiedStatus.status}`,
                context: CodeReviewHandlerService.name,
                serviceName: CodeReviewHandlerService.name,
                metadata: {
                    suggestionsCount: result?.lineComments?.length || 0,
                    organizationAndTeamData,
                    pullRequestNumber: pullRequest.number,
                    executionId,
                    finalStatus: classifiedStatus.status,
                    criticalErrors: hasCriticalError,
                    partialErrors: hasPartialError,
                },
            });

            if (classifiedStatus.status === AutomationStatus.SUCCESS) {
                void this.captureFirstReviewIfNeeded(
                    organizationAndTeamData,
                    repository,
                    pullRequest?.number,
                    platformType,
                );
            }

            const finalStatus = classifiedStatus;

            return {
                lastAnalyzedCommit: result?.lastAnalyzedCommit,
                commentId: result?.initialCommentData?.commentId,
                noteId: result?.initialCommentData?.noteId,
                threadId: result?.initialCommentData?.threadId,
                automaticReviewStatus: result?.automaticReviewStatus,
                statusInfo: finalStatus,
                orphanedBaseCommit: result?.orphanedBaseCommit,
                // Forward adaptive-fit fidelity warnings to the
                // automation_execution.dataExecution payload (see
                // _buildExecutionData) so the web dashboard can render
                // them. Absent on full-fidelity runs.
                reviewWarnings: result?.reviewWarnings,
            };
        } catch (error) {
            if (initialContext) {
                await this.removeCurrentReaction(initialContext);
                await this.addStatusReaction(
                    initialContext,
                    ReviewStatusReaction.ERROR,
                );
            }

            this.logger.error({
                message: `Error executing code review pipeline for PR#${pullRequest.number}`,
                context: CodeReviewHandlerService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    pullRequestNumber: pullRequest.number,
                    executionId,
                },
            });

            return null;
        }
    }

    private async handleReactionsByStatus(
        context: CodeReviewPipelineContext,
        result: CodeReviewPipelineContext,
    ): Promise<void> {
        const status = result.statusInfo?.status;

        if (status === AutomationStatus.SKIPPED) {
            if (this.shouldSuppressSkipFeedback(result)) {
                await this.removeCurrentReaction(context);
                return;
            }

            // If the specific stage already handled the notification (e.g. License check on Azure/BB), don't post a generic skip message.
            if (result.pipelineMetadata?.notificationHandled) {
                await this.removeCurrentReaction(context);
                this.logger.log({
                    message: `Review skipped for PR#${context.pullRequest.number} - notification already handled`,
                    context: CodeReviewHandlerService.name,
                    metadata: {
                        skipReason: result.statusInfo?.message,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });
                return;
            }

            await this.removeCurrentReaction(context);
            await this.addStatusReaction(result, ReviewStatusReaction.SKIP);

            this.logger.log({
                message: `Review skipped for PR#${context.pullRequest.number} - adding skip reaction`,
                context: CodeReviewHandlerService.name,
                metadata: {
                    skipReason: result.statusInfo?.message,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return;
        }

        if (status === AutomationStatus.ERROR) {
            await this.removeCurrentReaction(context);
            await this.addStatusReaction(result, ReviewStatusReaction.ERROR);

            this.logger.error({
                message: `Review failed for PR#${context.pullRequest.number} - adding error reaction`,
                context: CodeReviewHandlerService.name,
                metadata: {
                    errorReason: result.statusInfo?.message,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return;
        }

        // PARTIAL_ERROR reviews still produced PR comments and summaries —
        // signal it as a completed review (hooray) so the UI does not treat
        // the reaction as a hard failure. The check run downgrades to NEUTRAL
        // separately via the pipeline observer, which keeps the warning
        // visible where it matters (check status, not PR reactions).
        if (
            status === AutomationStatus.SUCCESS ||
            status === AutomationStatus.PARTIAL_ERROR ||
            status === AutomationStatus.IN_PROGRESS
        ) {
            await this.removeCurrentReaction(context);
            await this.addStatusReaction(result, ReviewStatusReaction.SUCCESS);
            return;
        }
    }

    private shouldSuppressSkipFeedback(
        context: CodeReviewPipelineContext,
    ): boolean {
        if (context.codeReviewConfig?.automatedReviewActive === false) {
            return true;
        }

        if (context.codeReviewConfig?.showStatusFeedback === false) {
            return true;
        }

        if (context.pipelineMetadata?.showStatusFeedback === false) {
            return true;
        }

        return false;
    }

    private async addStatusReaction(
        context: CodeReviewPipelineContext,
        status: ReviewStatusReaction,
    ): Promise<void> {
        try {
            const {
                organizationAndTeamData,
                repository,
                pullRequest,
                platformType,
                triggerCommentId,
            } = context;

            if (
                platformType === PlatformType.AZURE_REPOS ||
                platformType === PlatformType.BITBUCKET
            ) {
                const comment = this.statusToCommentMap[status];

                if (!comment) {
                    return;
                }

                if (
                    triggerCommentId &&
                    platformType === PlatformType.BITBUCKET
                ) {
                    await this.codeManagement.createResponseToComment({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        prNumber: pullRequest.number,
                        inReplyToId:
                            typeof triggerCommentId === 'string'
                                ? parseInt(triggerCommentId, 10) ||
                                  triggerCommentId
                                : triggerCommentId,
                        body: comment,
                    });
                } else {
                    await this.codeManagement.createIssueComment({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        prNumber: pullRequest.number,
                        body: comment,
                    });
                }
                return;
            }

            const reaction = this.reactionMap[platformType]?.[status];
            if (!reaction) {
                return;
            }

            if (triggerCommentId) {
                await this.codeManagement.addReactionToComment({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    commentId:
                        typeof triggerCommentId === 'string'
                            ? parseInt(triggerCommentId, 10)
                            : triggerCommentId,
                    reaction,
                });
            } else {
                await this.codeManagement.addReactionToPR({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    reaction,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error adding status reaction',
                context: CodeReviewHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    status,
                    platformType: context.platformType,
                    prNumber: context.pullRequest.number,
                },
            });
        }
    }

    private async removeCurrentReaction(
        context: CodeReviewPipelineContext,
    ): Promise<void> {
        try {
            const {
                organizationAndTeamData,
                repository,
                pullRequest,
                platformType,
                triggerCommentId,
            } = context;

            if (
                platformType === PlatformType.AZURE_REPOS ||
                platformType === PlatformType.BITBUCKET
            ) {
                return;
            }

            const platformReactions = this.reactionMap[platformType];
            if (!platformReactions) {
                return;
            }

            const reactionsToRemove = Object.values(
                platformReactions,
            ) as Reaction[];

            if (triggerCommentId) {
                await this.codeManagement.removeReactionsFromComment({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    commentId:
                        typeof triggerCommentId === 'string'
                            ? parseInt(triggerCommentId, 10)
                            : triggerCommentId,
                    reactions: reactionsToRemove,
                });
            } else {
                await this.codeManagement.removeReactionsFromPR({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                    reactions: reactionsToRemove,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error removing current reaction',
                context: CodeReviewHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    platformType: context.platformType,
                    prNumber: context.pullRequest.number,
                },
            });
        }
    }
}
