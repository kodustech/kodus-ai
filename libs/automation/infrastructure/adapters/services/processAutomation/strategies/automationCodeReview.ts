import { createLogger, getObservability } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { MoreThanOrEqual } from 'typeorm';

import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@libs/automation/domain/automation/contracts/automation.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationType } from '@libs/automation/domain/automation/enum/automation-type';
import { IAutomation } from '@libs/automation/domain/automation/interfaces/automation.interface';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';
import { IAutomationFactory } from '@libs/automation/domain/automationExecution/processAutomation/automation.factory';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { ITeamAutomation } from '@libs/automation/domain/teamAutomation/interfaces/team-automation.interface';
import { CodeReviewHandlerService } from '@libs/code-review/infrastructure/adapters/services/codeReviewHandlerService.service';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

@Injectable()
export class AutomationCodeReviewService implements Omit<
    IAutomationFactory,
    'stop'
> {
    private readonly logger = createLogger(AutomationCodeReviewService.name);
    automationType = AutomationType.AUTOMATION_CODE_REVIEW;

    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        private readonly codeReviewHandlerService: CodeReviewHandlerService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    async setup(payload?: any): Promise<any> {
        try {
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

            const teamAutomation: ITeamAutomation = {
                status: false,
                automation: {
                    uuid: automation.uuid,
                },
                team: {
                    uuid: payload.teamId,
                },
            };

            await this.teamAutomationService.register(teamAutomation);
        } catch (error) {
            this.logger.error({
                message: 'Error creating automation for the team',
                context: AutomationCodeReviewService.name,
                error: error instanceof Error ? error : undefined,
                metadata: payload,
            });
        }
    }

    async run?(payload?: any): Promise<any> {
        const obs = getObservability();
        const correlationId = obs.getContext()?.correlationId;

        const {
            organizationAndTeamData,
            repository,
            branch,
            pullRequest,
            platformType,
            teamAutomationId,
            origin,
            action,
            triggerCommentId,
            userGitId,
            // Job-level AbortSignal injected by RunCodeReviewAutomationUseCase.
            // Plumbed through handlePullRequest → pipeline context → agent-loop
            // so the router-level workflow timeout cancels the LLM call cleanly.
            signal,
        } = payload as Record<string, any>;

        // Acquire distributed lock to prevent concurrent reviews of the same PR
        const orgId = organizationAndTeamData?.organizationId;
        const repoId = repository?.id;
        const prNumber = pullRequest?.number;

        if (!orgId || !repoId || !prNumber) {
            this.logger.error({
                message:
                    'Cannot generate lock key due to missing identifiers in payload',
                context: AutomationCodeReviewService.name,
                metadata: { orgId, repoId, prNumber },
            });
            return 'Error: Missing required identifiers for code review';
        }

        const lockKey = `CODE_REVIEW:${orgId}:${repoId}:${prNumber}`;
        let lock: DistributedLock | null = null;

        try {
            lock = await this.distributedLockService.acquire(lockKey, {
                ttl: 1000 * 60, // 1 minute TTL
            });

            if (!lock) {
                this.logger.warn({
                    message: `Code review already being processed for PR#${pullRequest?.number}, skipping`,
                    context: AutomationCodeReviewService.name,
                    metadata: {
                        lockKey,
                        organizationAndTeamData,
                        repository: {
                            id: repository?.id,
                            name: repository?.name,
                        },
                        pullRequestNumber: pullRequest?.number,
                    },
                });
                return 'Code review already in progress for this PR';
            }
        } catch (error) {
            // Fail-open: if lock service is unavailable, proceed with the review
            // (better to risk a duplicate than to block all reviews)
            this.logger.error({
                message: `Error acquiring distributed lock for PR#${pullRequest?.number}, proceeding without lock`,
                context: AutomationCodeReviewService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { lockKey },
            });
        }

        let execution: IAutomationExecution | null = null;

        try {
            this.logger.log({
                message: `Started Handling pull request for ${repository?.name} - ${branch} - PR#${pullRequest?.number}`,
                context: AutomationCodeReviewService.name,
                metadata: {
                    organizationAndTeamData,
                },
            });

            // Check for existing active execution (defense in depth)
            const existingExecution = await this.getActiveExecution(
                teamAutomationId,
                pullRequest?.number,
                repository?.id,
            );

            if (existingExecution) {
                this.logger.warn({
                    message: `Code review already in progress for PR#${pullRequest?.number}`,
                    context: AutomationCodeReviewService.name,
                    metadata: {
                        existingExecutionId: existingExecution.uuid,
                        organizationAndTeamData,
                        repository,
                        pullRequestNumber: pullRequest?.number,
                    },
                });
                return 'Code review already in progress for this PR';
            }

            const organization = await this.organizationService.findOne({
                uuid: organizationAndTeamData.organizationId,
                status: true,
            });

            if (!organization) {
                this.logger.warn({
                    message: `No organization found with ID ${organizationAndTeamData.organizationId}`,
                    context: AutomationCodeReviewService.name,
                    metadata: {
                        organizationAndTeamData,
                        repository,
                        pullRequestNumber: pullRequest?.number,
                    },
                });
                return 'No organization found for the provided ID';
            }

            execution = await this.createAutomationExecution(
                payload,
                AutomationStatus.IN_PROGRESS,
                '',
            );

            if (!execution) {
                this.logger.warn({
                    message: `Could not create code review execution for PR #${pullRequest?.number}`,
                    context: AutomationCodeReviewService.name,
                    metadata: {
                        organizationAndTeamData,
                        repository,
                        pullRequestNumber: pullRequest?.number,
                    },
                });
                return 'Could not create code review execution';
            }

            // Check for pre-validation error passed from UseCase
            if (payload.validationError) {
                this.logger.warn({
                    message: `Automation blocked by validation error: ${payload.validationError.errorType}`,
                    context: AutomationCodeReviewService.name,
                    metadata: {
                        executionUuid: execution.uuid,
                        validationError: payload.validationError,
                    },
                });

                await this.updateAutomationExecution(
                    execution,
                    AutomationStatus.ERROR,
                    `Blocked by validation: ${payload.validationError.errorType}`,
                    this._buildExecutionData(payload),
                );
                return `Automation blocked: ${payload.validationError.errorType}`;
            }

            // Fetch the last successful execution to pass to the handler
            const lastExecution =
                await this.automationExecutionService.findLatestExecutionByFilters(
                    {
                        status: AutomationStatus.SUCCESS,
                        teamAutomation: { uuid: teamAutomationId },
                        pullRequestNumber: pullRequest?.number,
                        repositoryId: repository?.id,
                    },
                );

            const result =
                await this.codeReviewHandlerService.handlePullRequest(
                    {
                        ...organizationAndTeamData,
                        organizationName: organization.name,
                    },
                    repository,
                    branch,
                    pullRequest,
                    platformType,
                    teamAutomationId,
                    origin || 'automation',
                    action,
                    execution.uuid,
                    triggerCommentId,
                    userGitId,
                    undefined, // workflowJobId
                    lastExecution?.dataExecution, // Pass last execution data
                    correlationId,
                    signal, // parentSignal — forwarded to pipeline context
                );

            await this._handleExecutionCompletion(execution, result, payload);
            return 'Automation executed successfully';
        } catch (error) {
            await this._handleExecutionError(execution, error, payload);
            return 'Error executing automation';
        } finally {
            if (lock) {
                try {
                    await lock.release();
                } catch (error) {
                    this.logger.error({
                        message: `Error releasing distributed lock for PR#${pullRequest?.number}`,
                        context: AutomationCodeReviewService.name,
                        error: error instanceof Error ? error : undefined,
                        metadata: { lockKey },
                    });
                }
            }
        }
    }

    private async getActiveExecution(
        teamAutomationId: string,
        pullRequestNumber: number,
        repositoryId: string,
    ): Promise<IAutomationExecution | null> {
        try {
            const cutoffTime = new Date();
            cutoffTime.setMinutes(cutoffTime.getMinutes() - 30);

            const activeExecutions = await this.automationExecutionService.find(
                {
                    teamAutomation: { uuid: teamAutomationId },
                    pullRequestNumber: pullRequestNumber,
                    repositoryId: repositoryId,
                    status: AutomationStatus.IN_PROGRESS,
                    createdAt: MoreThanOrEqual(cutoffTime),
                } as any,
            );

            return activeExecutions?.[0] || null;
        } catch (error) {
            this.logger.error({
                message: 'Error checking for active execution',
                context: AutomationCodeReviewService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { teamAutomationId, pullRequestNumber, repositoryId },
            });
            return null;
        }
    }

    private async createAutomationExecution(
        payload: any,
        status: AutomationStatus,
        message: string,
    ) {
        const {
            organizationAndTeamData,
            pullRequest,
            repository,
            teamAutomationId,
            platformType,
            origin,
        } = payload;

        try {
            const result =
                await this.automationExecutionService.createCodeReview(
                    {
                        status,
                        dataExecution: {
                            platformType,
                            organizationAndTeamData,
                            pullRequestNumber: pullRequest?.number,
                            repositoryId: repository?.id,
                            workflowJobId: payload.workflowJobId,
                            correlationId: payload.correlationId,
                        },
                        teamAutomation: { uuid: teamAutomationId },
                        origin: origin || 'System',
                        pullRequestNumber: pullRequest?.number,
                        repositoryId: repository?.id,
                    },
                    message,
                    'Kody Review Started',
                );

            if (result?.stageLog) {
                await this.automationExecutionService.updateStageLog(
                    result.stageLog.uuid,
                    {
                        status: AutomationStatus.SUCCESS,
                    },
                );
            }

            return result?.execution;
        } catch (error: any) {
            // Check for unique constraint violation (PostgreSQL error code 23505)
            const isDuplicateError =
                error?.code === '23505' ||
                error?.constraint?.includes('unique') ||
                error?.message?.includes('duplicate');

            if (isDuplicateError) {
                this.logger.warn({
                    message:
                        'Duplicate execution detected - another process is already handling this PR',
                    context: AutomationCodeReviewService.name,
                    metadata: {
                        teamAutomationId,
                        pullRequestNumber: pullRequest?.number,
                        repositoryId: repository?.id,
                    },
                });
                return null;
            }

            this.logger.error({
                message: 'Error creating automation execution',
                context: AutomationCodeReviewService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { teamAutomationId, status },
            });
            return null;
        }
    }

    private async updateAutomationExecution(
        entity: IAutomationExecution,
        status: AutomationStatus,
        message: string,
        data: any,
        stageName?: string,
    ) {
        try {
            const errorMessage = [
                AutomationStatus.ERROR,
                AutomationStatus.SKIPPED,
            ].includes(status)
                ? message
                : undefined;

            await this.automationExecutionService.updateCodeReview(
                { uuid: entity.uuid },
                {
                    status,
                    dataExecution: { ...entity.dataExecution, ...data },
                    errorMessage,
                },
                message,
                stageName,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error updating automation execution',
                context: AutomationCodeReviewService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { executionUuid: entity.uuid, status },
            });
        }
    }

    private async _handleExecutionCompletion(
        execution: IAutomationExecution,
        result: any,
        payload: any,
    ) {
        if (!result) {
            await this.updateAutomationExecution(
                execution,
                AutomationStatus.ERROR,
                'Error processing the pull request: handler returned no result.',
                this._buildExecutionData(payload),
            );
            return;
        }

        const finalStatus = this.deriveFinalStatus(result);
        const finalMessage =
            result.statusInfo?.message || 'Automation completed successfully.';
        const newData = this._buildExecutionData(payload, result);

        await this.updateAutomationExecution(
            execution,
            finalStatus,
            finalMessage,
            newData,
            'Kody Review Finished',
        );

        this.logger.log({
            message: `Successfully handled pull request for PR#${payload.pullRequest?.number}`,
            context: AutomationCodeReviewService.name,
            metadata: {
                organizationAndTeamData: payload.organizationAndTeamData,
                ...result,
            },
        });
    }

    /**
     * Derive the final automation_execution.status from the returned
     * pipeline context. Single source of truth for the review outcome
     * downstream (cron auto-approve, dashboards, retry policies).
     *
     * Precedence:
     *  1. SKIPPED — preserved as-is. A stage explicitly skipped the run
     *     (no new commits, etc.); not a failure.
     *  2. Any errors[].severity === 'critical' → ERROR. The agent's main
     *     review path failed OR a structural pre-agent stage threw
     *     (sandbox / fetch / validation). Either way the review is not
     *     trustworthy.
     *  3. Any errors[].severity === 'partial' → PARTIAL_ERROR. Auxiliary
     *     work failed (kody-rules agent, summary, PR-level comments)
     *     but the main review still has value. Cron auto-approve filters
     *     by SUCCESS, so this still blocks auto-approve — by design,
     *     because the user should decide what to do about the gap.
     *  4. Fallback to statusInfo.status or SUCCESS.
     *
     * Default severity (when omitted on a pushed error) is 'critical' —
     * matches PipelineErrorSeverity's documented default and the
     * observer's behavior.
     */
    private deriveFinalStatus(result: any): AutomationStatus {
        const statusInfoStatus = result?.statusInfo?.status as
            | AutomationStatus
            | undefined;

        if (statusInfoStatus === AutomationStatus.SKIPPED) {
            return AutomationStatus.SKIPPED;
        }

        const errors: Array<{ severity?: 'critical' | 'partial' }> =
            Array.isArray(result?.errors) ? result.errors : [];

        const hasCritical = errors.some(
            (e) => (e?.severity ?? 'critical') === 'critical',
        );
        if (hasCritical) {
            return AutomationStatus.ERROR;
        }

        const hasPartial = errors.some((e) => e?.severity === 'partial');
        if (hasPartial) {
            return AutomationStatus.PARTIAL_ERROR;
        }

        return statusInfoStatus || AutomationStatus.SUCCESS;
    }

    private async _handleExecutionError(
        execution: IAutomationExecution,
        error: any,
        payload: any,
    ) {
        const errorMessage =
            error.message ||
            'An unexpected error occurred during code review automation.';

        this.logger.error({
            message: errorMessage,
            context: AutomationCodeReviewService.name,
            error: error instanceof Error ? error : undefined,
            metadata: payload,
        });

        await this.updateAutomationExecution(
            execution,
            AutomationStatus.ERROR,
            errorMessage,
            this._buildExecutionData(payload),
        );
    }

    private _buildExecutionData(payload: any, result?: any): any {
        const {
            codeManagementEvent,
            platformType,
            organizationAndTeamData,
            pullRequest,
            repository,
        } = payload;

        const baseData = {
            codeManagementEvent,
            platformType,
            organizationAndTeamData,
            pullRequestNumber: pullRequest?.number,
            repositoryId: repository?.id,
        };

        if (!result) {
            return baseData;
        }

        const validLastAnalyzedCommit =
            result.lastAnalyzedCommit &&
            typeof result.lastAnalyzedCommit === 'object' &&
            Object.keys(result.lastAnalyzedCommit).length > 0;

        if (validLastAnalyzedCommit) {
            Object.assign(baseData, {
                lastAnalyzedCommit: result.lastAnalyzedCommit,
                commentId: result.commentId,
                noteId: result.noteId,
                threadId: result.threadId,
                automaticReviewStatus: result.automaticReviewStatus,
            });
        }

        if (result.orphanedBaseCommit) {
            Object.assign(baseData, {
                orphanedBaseCommit: result.orphanedBaseCommit,
            });
        }

        if (result.businessLogicPrBodyHash) {
            Object.assign(baseData, {
                businessLogicHash: result.businessLogicPrBodyHash,
            });
        }

        // Adaptive-fit fidelity warnings — emitted by the agent pipeline
        // when a small context window forced a degraded path (compact
        // prompt, dropped callGraph, etc). Persisted here so the
        // admin-facing Pull Requests dashboard in the Kodus web app can
        // surface them — the PR author's GitHub comment intentionally
        // omits this (it's an operator concern, not an author concern).
        if (
            Array.isArray(result.reviewWarnings) &&
            result.reviewWarnings.length > 0
        ) {
            Object.assign(baseData, {
                reviewWarnings: result.reviewWarnings,
            });
        }

        return baseData;
    }
}
