import { createLogger } from '@kodus/flow';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import {
    IPipelineChecksService,
    PIPELINE_CHECKS_SERVICE_TOKEN,
} from '@libs/core/infrastructure/pipeline/interfaces/pipeline-checks-service.interface';
import {
    IPipelineObserver,
    PipelineObserverContext,
} from '@libs/core/infrastructure/pipeline/interfaces/pipeline-observer.interface';
import { CheckStageNames } from '@libs/core/infrastructure/pipeline/services/pipeline-checks.service';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CodeReviewPipelineObserver implements IPipelineObserver {
    private readonly logger = createLogger(CodeReviewPipelineObserver.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(PIPELINE_CHECKS_SERVICE_TOKEN)
        private readonly pipelineChecksService: IPipelineChecksService,
    ) {}

    async onPipelineStart(
        context: CodeReviewPipelineContext,
        observerContext: PipelineObserverContext,
    ): Promise<void> {
        await this.pipelineChecksService.startCheck(
            observerContext,
            context,
            '_pipelineStart',
        );
    }

    async onPipelineFinish(
        context: CodeReviewPipelineContext,
        observerContext: PipelineObserverContext,
    ): Promise<void> {
        // Clean up sandbox to prevent disk space leaks
        if (context.sandboxHandle?.cleanup) {
            try {
                await context.sandboxHandle.cleanup();
            } catch (err) {
                this.logger.warn({
                    message: 'Sandbox cleanup failed on pipeline finish',
                    context: CodeReviewPipelineObserver.name,
                    error: err,
                });
            }
        }

        if (context.statusInfo.status === AutomationStatus.SKIPPED) {
            const reason = context.statusInfo.message;

            await this.pipelineChecksService.finalizeCheck(
                observerContext,
                context,
                CheckConclusion.SKIPPED,
                CheckStageNames._pipelineEndSkipped,
                reason,
            );
            return;
        }

        // Classify collected errors by severity. Errors with severity === 'partial'
        // come from stages that declared `errorSeverity = 'partial'` (business
        // logic, PR-level comments, summary, verify, kody-rules agent) and
        // should degrade the review to PARTIAL_ERROR / neutral rather than
        // red-flagging the whole run.
        const errors = context.errors || [];
        const hasCriticalError =
            context.statusInfo.status === AutomationStatus.ERROR ||
            errors.some((e) => (e.severity ?? 'critical') === 'critical');
        const hasPartialError =
            context.statusInfo.status === AutomationStatus.PARTIAL_ERROR ||
            errors.some((e) => e.severity === 'partial');

        if (hasCriticalError) {
            const failureReason = this.buildPipelineFailureReason(context);
            await this.pipelineChecksService.finalizeCheck(
                observerContext,
                context,
                CheckConclusion.FAILURE,
                CheckStageNames._pipelineEndFailure,
                failureReason,
            );
            return;
        }

        if (hasPartialError) {
            const partialReason = this.buildPipelineFailureReason(context);
            await this.pipelineChecksService.finalizeCheck(
                observerContext,
                context,
                CheckConclusion.NEUTRAL,
                CheckStageNames._pipelineEndPartial,
                partialReason,
            );
            return;
        }

        await this.pipelineChecksService.finalizeCheck(
            observerContext,
            context,
            CheckConclusion.SUCCESS,
            CheckStageNames._pipelineEndSuccess,
        );
    }

    private buildPipelineFailureReason(
        context: CodeReviewPipelineContext,
    ): string | undefined {
        const statusMessage = context.statusInfo?.message?.trim();
        const genericMessages = [
            'pipeline started',
            'code review started',
            'code review failed',
            'reviewing file level',
        ];

        const parts: string[] = [];

        if (
            statusMessage &&
            statusMessage.length > 0 &&
            !genericMessages.some((m) =>
                statusMessage.toLowerCase().includes(m),
            )
        ) {
            parts.push(statusMessage);
        }

        const errorsByMessage = new Map<string, number>();

        (context.errors || []).forEach((item) => {
            const message = item.error?.message?.trim();
            if (message) {
                errorsByMessage.set(
                    message,
                    (errorsByMessage.get(message) || 0) + 1,
                );
            }
        });

        if (errorsByMessage.size > 0) {
            const summaryParts: string[] = [];
            errorsByMessage.forEach((count, message) => {
                const countStr = count > 1 ? ` (${count} files/stages)` : '';
                summaryParts.push(`- ${message}${countStr}`);
            });
            // Limit to top 5 distinct error messages to avoid huge titles
            const limit = 5;
            parts.push(...summaryParts.slice(0, limit));
            if (summaryParts.length > limit) {
                parts.push(`- +${summaryParts.length - limit} more errors`);
            }
        }

        if (parts.length === 0) {
            return undefined;
        }

        return parts.join('\n');
    }

    async onStageStart(
        stageName: string,
        context: CodeReviewPipelineContext,
        observerContext: PipelineObserverContext,
        options?: { visibility?: StageVisibility; label?: string },
    ): Promise<void> {
        await this.pipelineChecksService.updateCheck(
            observerContext,
            context,
            stageName,
            CheckStatus.IN_PROGRESS,
        );
        await this.logStage(
            stageName,
            AutomationStatus.IN_PROGRESS,
            'Starting...',
            context,
            options,
        );
    }

    async onStageFinish(
        stageName: string,
        context: CodeReviewPipelineContext,
        observerContext: PipelineObserverContext,
        options?: { visibility?: StageVisibility; label?: string },
    ): Promise<void> {
        const errors =
            context.errors?.filter((e) => e.stage === stageName) || [];
        let additionalMetadata: Record<string, any> | undefined;

        if (errors.length > 0) {
            additionalMetadata = {
                partialErrors: errors.map((e) => ({
                    file: e.substage || 'unknown',
                    message: e.error?.message || String(e.error),
                    isTimeout: e.metadata?.isTimeout || false,
                    ...e.metadata,
                })),
            };
        }

        if (
            stageName === 'FileAnalysisStage' &&
            context.fileMetadata?.size > 0
        ) {
            additionalMetadata = additionalMetadata || {};
            const fileTimings: Array<{
                file: string;
                durationMs: number;
                status: 'success' | 'error' | 'timeout';
            }> = [];

            context.fileMetadata.forEach((meta: any, filename: string) => {
                if (meta?.durationMs != null) {
                    fileTimings.push({
                        file: filename,
                        durationMs: meta.durationMs,
                        status: meta.isTimeout
                            ? 'timeout'
                            : meta.hasError
                              ? 'error'
                              : 'success',
                    });
                }
            });

            if (fileTimings.length > 0) {
                fileTimings.sort((a, b) => b.durationMs - a.durationMs);
                additionalMetadata.fileTimings = fileTimings;
            }
        }

        const ignoredFilesMetadata = this.getIgnoredFilesMetadata(
            stageName,
            context,
        );
        if (ignoredFilesMetadata) {
            additionalMetadata = additionalMetadata || {};
            Object.assign(additionalMetadata, ignoredFilesMetadata);
        }

        if (stageName === 'AgentReviewStage' && context.dedupTrace) {
            additionalMetadata = additionalMetadata || {};
            additionalMetadata.dedupTrace = context.dedupTrace;
        }

        // Stage status respects error severity (matches deriveFinalStatus
        // in automationCodeReview.ts so the per-stage badge and the
        // automation rollup agree). Before this, a critical agent failure
        // (e.g. AgentReviewStage with severity='critical') showed the
        // stage as PARTIAL_ERROR while the rollup correctly showed ERROR —
        // confusing UI where the stage said "Partial Error" but the same
        // run's final stage said "Error". Default severity is 'critical'
        // when omitted, matching PipelineErrorSeverity's documented default.
        const hasCriticalError = errors.some(
            (e) => (e.severity ?? 'critical') === 'critical',
        );
        let status =
            errors.length === 0
                ? AutomationStatus.SUCCESS
                : hasCriticalError
                  ? AutomationStatus.ERROR
                  : AutomationStatus.PARTIAL_ERROR;

        let label = options?.label;

        // BusinessLogicValidationStage reports its outcome via context.businessLogicOutcome
        // (it cannot use statusInfo without aborting the whole pipeline). Map it to the
        // per-stage log status here so the UI shows the correct badge.
        if (
            stageName === 'BusinessLogicValidationStage' &&
            context.businessLogicOutcome
        ) {
            const outcome = context.businessLogicOutcome;
            if (outcome.kind === 'skipped') {
                status = AutomationStatus.SKIPPED;
            } else if (outcome.kind === 'error') {
                status = AutomationStatus.ERROR;
            } else {
                status = AutomationStatus.SUCCESS;
            }
            additionalMetadata = additionalMetadata || {};
            additionalMetadata.businessLogicOutcome = outcome;
        }

        if (stageName === 'FileAnalysisStage') {
            const totalFiles = context.changedFiles?.length || 0;
            const errorCount = errors.length;

            if (errorCount > 0) {
                if (errorCount >= totalFiles) {
                    status = AutomationStatus.ERROR;
                } else {
                    status = AutomationStatus.PARTIAL_ERROR;
                }
            }

            label = `Reviewing File Level (${totalFiles} files)`;
        }

        if (stageName === 'CreatePrLevelCommentsStage') {
            const count = context.validSuggestionsByPR?.length || 0;
            label =
                count > 0
                    ? `Posting PR Comments (${count} comments)`
                    : `Posting PR Comments (No suggestions)`;
        }

        if (stageName === 'CreateFileCommentsStage') {
            const count = context.validSuggestions?.length || 0;
            label =
                count > 0
                    ? `Posting File Comments (${count} comments)`
                    : `Posting File Comments (No suggestions)`;
        }

        let message = '';
        if (errors.length > 0) {
            const uniqueMessages = [
                ...new Set(
                    errors.map((e) => e.error?.message || String(e.error)),
                ),
            ];
            const displayMessages = uniqueMessages.slice(0, 3);
            const remaining = uniqueMessages.length - displayMessages.length;

            message = `${displayMessages.join('\n')}${remaining > 0 ? `\n(+${remaining} more)` : ''}`;
        }

        // Surface the BusinessLogicValidationStage outcome message so the
        // PR logs UI shows WHY (skipped reason, gap detected, alignment ok).
        if (
            !message &&
            stageName === 'BusinessLogicValidationStage' &&
            context.businessLogicOutcome?.message
        ) {
            message = context.businessLogicOutcome.message;
        }

        await this.logStage(stageName, status, message, context, {
            additionalMetadata,
            ...options,
            label,
        });
    }

    async onStageError(
        stageName: string,
        error: Error,
        context: CodeReviewPipelineContext,
        observerContext: PipelineObserverContext,
        options?: { visibility?: StageVisibility; label?: string },
    ): Promise<void> {
        await this.logStage(
            stageName,
            AutomationStatus.ERROR,
            error.message,
            context,
            options,
        );
    }

    async onStageSkipped(
        stageName: string,
        reason: string,
        context: CodeReviewPipelineContext,
        observerContext: PipelineObserverContext,
        options?: { visibility?: StageVisibility; label?: string },
    ): Promise<void> {
        const additionalMetadata = this.getIgnoredFilesMetadata(
            stageName,
            context,
        );

        await this.logStage(
            stageName,
            AutomationStatus.SKIPPED,
            reason,
            context,
            { ...options, additionalMetadata },
        );
    }

    private getIgnoredFilesMetadata(
        stageName: string,
        context: CodeReviewPipelineContext,
    ): Record<string, any> | undefined {
        if (
            stageName === 'FetchChangedFilesStage' &&
            context.ignoredFiles &&
            context.ignoredFiles.length > 0
        ) {
            return {
                ignoredFiles: context.ignoredFiles.slice(0, 50),
            };
        }
        return undefined;
    }

    private async logStage(
        stageName: string,
        status: AutomationStatus,
        message: string,
        context: CodeReviewPipelineContext,
        options?: {
            visibility?: StageVisibility;
            label?: string;
            additionalMetadata?: Record<string, any>;
        },
    ): Promise<void> {
        // Only use correlationId as a fallback executionUuid when it looks
        // like a real UUID — the CLI generates `corr_xxxx` correlation ids
        // that would break uuid-typed DB queries if passed through.
        const UUID_REGEX =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const correlationIdIsUuid =
            typeof context.correlationId === 'string' &&
            UUID_REGEX.test(context.correlationId);
        let executionUuid =
            context.pipelineMetadata?.lastExecution?.uuid ||
            (correlationIdIsUuid ? context.correlationId : undefined);
        const pullRequestNumber = context.pullRequest?.number;
        const repositoryId = context.repository?.id;

        if (!executionUuid && (!pullRequestNumber || !repositoryId)) {
            this.logger.warn({
                message: 'Missing context data for logging stage',
                context: CodeReviewPipelineObserver.name,
                metadata: {
                    stageName,
                    status,
                    executionUuid,
                    pullRequestNumber,
                    repositoryId,
                },
            });
            return;
        }

        const { visibility, label, additionalMetadata } = options || {};
        const metadata: any = visibility ? { visibility } : {};

        if (label) {
            metadata.label = label;
        }

        if (additionalMetadata) {
            Object.assign(metadata, additionalMetadata);
        }

        const metadataToSend =
            Object.keys(metadata).length > 0 ? metadata : undefined;

        if (status === AutomationStatus.IN_PROGRESS) {
            const filter: Partial<IAutomationExecution> = executionUuid
                ? { uuid: executionUuid }
                : { pullRequestNumber, repositoryId };

            await this.automationExecutionService.updateCodeReview(
                filter,
                { status },
                message,
                stageName,
                metadataToSend,
            );
            return;
        }

        if (!executionUuid) {
            const found =
                await this.automationExecutionService.findLatestExecutionByFilters(
                    {
                        pullRequestNumber,
                        repositoryId,
                        status: AutomationStatus.IN_PROGRESS,
                    },
                );

            if (found) {
                executionUuid = found.uuid;
            }
        }

        if (executionUuid) {
            const found =
                await this.automationExecutionService.findLatestStageLog(
                    executionUuid,
                    stageName,
                );

            if (found) {
                const updateData: any = { status, message };
                if (
                    [
                        AutomationStatus.SUCCESS,
                        AutomationStatus.ERROR,
                        AutomationStatus.PARTIAL_ERROR,
                        AutomationStatus.SKIPPED,
                    ].includes(status)
                ) {
                    updateData.finishedAt = new Date();
                }

                if (metadataToSend) {
                    updateData.metadata = {
                        ...(found.metadata || {}),
                        ...metadataToSend,
                    };
                }

                await this.automationExecutionService.updateStageLog(
                    found.uuid,
                    updateData,
                );
                return;
            }
        }

        const filter: Partial<IAutomationExecution> = executionUuid
            ? { uuid: executionUuid }
            : { pullRequestNumber, repositoryId };

        await this.automationExecutionService.updateCodeReview(
            filter,
            { status },
            message,
            stageName,
            metadataToSend,
        );
    }
}
