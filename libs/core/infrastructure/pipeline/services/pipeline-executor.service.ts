import { createLogger } from '@kodus/flow';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { produce } from 'immer';
import { v4 as uuid } from 'uuid';
import {
    PipelineContext,
    PipelineError,
    PipelineErrorSeverity,
} from '../interfaces/pipeline-context.interface';
import {
    IPipelineObserver,
    PipelineObserverContext,
} from '../interfaces/pipeline-observer.interface';
import { PipelineStage } from '../interfaces/pipeline.interface';

type SkipDecision = 'EXECUTE_STAGE' | 'SKIP_STAGE' | 'ABORT_PIPELINE';

export class PipelineExecutor<TContext extends PipelineContext> {
    private readonly logger = createLogger(PipelineExecutor.name);

    constructor(private readonly metricsCollector?: MetricsCollectorService) {}

    private toError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private appendStageExecutionError(
        context: TContext,
        stageName: string,
        pipelineName: string,
        pipelineId: string,
        error: unknown,
        processedErrors: Set<string>,
        severity: PipelineErrorSeverity,
    ): TContext {
        const parsedError = this.toError(error);
        const errorKey = `${stageName}:StageExecution:${parsedError.message}`;

        if (processedErrors.has(errorKey)) {
            return context;
        }

        processedErrors.add(errorKey);

        return produce(context, (draft) => {
            if (!Array.isArray(draft.errors)) {
                draft.errors = [];
            }

            const pipelineError: PipelineError = {
                pipelineId,
                stage: stageName,
                substage: 'StageExecution',
                error: parsedError,
                severity,
                metadata: {
                    nonBlocking: true,
                    pipelineName,
                },
            };

            draft.errors.push(pipelineError);
        });
    }

    async execute(
        context: TContext,
        stages: PipelineStage<TContext>[],
        pipelineName = 'UnnamedPipeline',
        parentPipelineId?: string,
        rootPipelineId?: string,
        observers: IPipelineObserver[] = [],
    ): Promise<TContext> {
        const pipelineId = uuid();

        context.pipelineMetadata = {
            ...(context.pipelineMetadata || {}),
            pipelineId,
            parentPipelineId,
            rootPipelineId: rootPipelineId || pipelineId,
            pipelineName,
        };

        this.logger.log({
            message: `Starting pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            serviceName: PipelineExecutor.name,
            metadata: {
                ...context?.pipelineMetadata,
                correlationId: (context as any)?.correlationId ?? null,
                organizationAndTeamData:
                    (context as any)?.organizationAndTeamData ?? null,
                status: context.statusInfo,
            },
        });

        const observersContext = {};

        await this.notifyObservers(
            observers,
            (obs) => obs.onPipelineStart(context, observersContext),
            'onPipelineStart',
        );

        const processedErrors = new Set<string>();
        if (context.errors && Array.isArray(context.errors)) {
            context.errors.forEach((e) => {
                if (e.error?.message) {
                    processedErrors.add(
                        `${e.stage}:${e.substage}:${e.error.message}`,
                    );
                }
            });
        }

        for (const stage of stages) {
            // Per-stage opt-out: skipStages bypasses specific named stages
            // without changing pipeline status. Checked before the SKIPPED
            // fast-forward so a stage listed here is excluded from both
            // execution and any jumpToStage match.
            if (
                context.statusInfo.skipStages?.includes(stage.stageName)
            ) {
                this.logger.log({
                    message: `Skipping stage '${stage.stageName}' — listed in statusInfo.skipStages`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    metadata: {
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        correlationId:
                            (context as any)?.correlationId ?? null,
                        status: context.statusInfo,
                    },
                });
                continue;
            }

            // Check if we need to handle skip/jump logic
            if (context.statusInfo.status === AutomationStatus.SKIPPED) {
                const result = await this.handleSkipOrJump(
                    context,
                    stage,
                    pipelineName,
                    pipelineId,
                );

                context = result.newContext;

                if (result.decision === 'ABORT_PIPELINE') {
                    break;
                }

                if (result.decision === 'SKIP_STAGE') {
                    continue;
                }
            }

            const start = Date.now();

            if (!stage.silent) {
                await this.notifyObservers(
                    observers,
                    (obs) =>
                        obs.onStageStart(
                            stage.stageName,
                            context,
                            observersContext,
                            {
                                visibility: stage.visibility,
                                label: stage.label,
                            },
                        ),
                    'onStageStart',
                );
            }

            try {
                context = await stage.execute(context);

                if (!stage.silent) {
                    await this.notifyStageCompletion(
                        stage,
                        context,
                        observers,
                        observersContext,
                    );
                }

                const stageDurationMs = Date.now() - start;
                this.metricsCollector?.recordHistogram(
                    'pipeline_stage_duration_ms',
                    stageDurationMs,
                    { pipeline: pipelineName, stage: stage.stageName },
                );

                this.logger.log({
                    message: `Stage '${stage.stageName}' completed in ${stageDurationMs}ms: ${pipelineId}`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    metadata: {
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        correlationId: (context as any)?.correlationId ?? null,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });
            } catch (error) {
                const parsedError = this.toError(error);

                if (!stage.silent) {
                    await this.notifyObservers(
                        observers,
                        (obs) =>
                            obs.onStageError(
                                stage.stageName,
                                error,
                                context,
                                observersContext,
                                {
                                    visibility: stage.visibility,
                                    label: stage.label,
                                },
                            ),
                        'onStageError',
                    );
                }

                this.metricsCollector?.recordCounter(
                    'pipeline_stage_errors_total',
                    1,
                    { pipeline: pipelineName, stage: stage.stageName },
                );

                this.logger.error({
                    message: `Stage '${stage.stageName}' failed: ${parsedError.message}`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    error: error,
                    metadata: {
                        correlationId: (context as any)?.correlationId ?? null,
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });

                // Respect per-stage criticality: stages that opt into
                // 'partial' contribute to PARTIAL_ERROR / NEUTRAL instead of
                // failing the whole review. `BasePipelineStage` defaults to
                // 'critical', so existing behavior is preserved for stages
                // that have not been audited yet.
                const stageSeverity: PipelineErrorSeverity =
                    (stage as Partial<{ errorSeverity: PipelineErrorSeverity }>)
                        .errorSeverity ?? 'critical';

                context = this.appendStageExecutionError(
                    context,
                    stage.stageName,
                    pipelineName,
                    pipelineId,
                    parsedError,
                    processedErrors,
                    stageSeverity,
                );

                this.logger.warn({
                    message: `Pipeline '${pipelineName}:${pipelineId}' continuing despite error in stage '${stage.stageName}'`,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                    metadata: {
                        ...context?.pipelineMetadata,
                        stage: stage.stageName,
                        correlationId: (context as any)?.correlationId ?? null,
                        organizationAndTeamData:
                            (context as any)?.organizationAndTeamData ?? null,
                        status: context.statusInfo,
                    },
                });
            }
        }

        // Restore skipped status if needed (for historical accuracy)
        if (context.statusInfo.skippedReason) {
            context = produce(context, (draft) => {
                const reason = draft.statusInfo.skippedReason!;
                draft.statusInfo.status = reason.status;

                if (reason.message) {
                    draft.statusInfo.message = reason.message;
                }
            });
        }

        this.logger.log({
            message: `Finished pipeline: ${pipelineName} (ID: ${pipelineId})`,
            context: PipelineExecutor.name,
            serviceName: PipelineExecutor.name,
            metadata: {
                ...context?.pipelineMetadata,
                correlationId: (context as any)?.correlationId ?? null,
                organizationAndTeamData:
                    (context as any)?.organizationAndTeamData ?? null,
            },
        });

        await this.notifyObservers(
            observers,
            (obs) => obs.onPipelineFinish(context, observersContext),
            'onPipelineFinish',
        );

        return context;
    }

    private async notifyStageCompletion(
        stage: PipelineStage<TContext>,
        context: TContext,
        observers: IPipelineObserver[],
        observersContext: PipelineObserverContext,
    ): Promise<void> {
        if (context.statusInfo.status === AutomationStatus.SKIPPED) {
            await this.notifyObservers(
                observers,
                (obs) =>
                    obs.onStageSkipped(
                        stage.stageName,
                        context.statusInfo.message || 'Stage skipped',
                        context,
                        observersContext,
                        {
                            visibility: stage.visibility,
                            label: stage.label,
                        },
                    ),
                'onStageSkipped',
            );
        } else {
            await this.notifyObservers(
                observers,
                (obs) =>
                    obs.onStageFinish(
                        stage.stageName,
                        context,
                        observersContext,
                        {
                            visibility: stage.visibility,
                            label: stage.label,
                        },
                    ),
                'onStageFinish',
            );
        }
    }

    private async notifyObservers(
        observers: IPipelineObserver[],
        callback: (observer: IPipelineObserver) => Promise<void>,
        actionName: string,
    ): Promise<void> {
        for (const observer of observers) {
            try {
                await callback(observer);
            } catch (error) {
                this.logger.error({
                    message: `Observer ${actionName} failed`,
                    error: error as Error,
                    context: PipelineExecutor.name,
                    serviceName: PipelineExecutor.name,
                });
            }
        }
    }

    private async handleSkipOrJump(
        context: TContext,
        stage: PipelineStage<TContext>,
        pipelineName: string,
        pipelineId: string,
    ): Promise<{ decision: SkipDecision; newContext: TContext }> {
        const targetStage = context.statusInfo.jumpToStage;

        if (!targetStage) {
            this.logger.log({
                message: `Pipeline '${pipelineName}' skipped due to SKIP status ${pipelineId}`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
                metadata: {
                    ...context?.pipelineMetadata,
                    stage: stage.stageName,
                    correlationId: (context as any)?.correlationId ?? null,
                    organizationAndTeamData:
                        (context as any)?.organizationAndTeamData ?? null,
                    status: context.statusInfo,
                },
            });

            return { decision: 'ABORT_PIPELINE', newContext: context };
        }

        if (stage.stageName !== targetStage) {
            this.logger.log({
                message: `Skipping stage '${stage.stageName}' while looking for '${targetStage}'`,
                context: PipelineExecutor.name,
                serviceName: PipelineExecutor.name,
                metadata: {
                    ...context?.pipelineMetadata,
                    stage: stage.stageName,
                    correlationId: (context as any)?.correlationId ?? null,
                    status: context.statusInfo,
                },
            });
            return { decision: 'SKIP_STAGE', newContext: context };
        }

        const newContext = produce(context, (draft) => {
            draft.statusInfo.skippedReason = {
                status: context.statusInfo.status,
                message: context.statusInfo.message,
                stageName: stage.stageName,
                jumpToStage: context.statusInfo.jumpToStage,
            };

            draft.statusInfo.jumpToStage = undefined;
            draft.statusInfo.status = AutomationStatus.IN_PROGRESS;
        });

        return { decision: 'EXECUTE_STAGE', newContext };
    }
}
