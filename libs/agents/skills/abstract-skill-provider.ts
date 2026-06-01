import { Thread, createLogger } from '@kodus/flow';
import { PromptRunnerService } from '@kodus/kodus-common/llm';

import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    BlueprintStepContractViolationError,
    runBlueprint,
} from '@libs/shared/blueprint/blueprint.runner';
import {
    BlueprintContext,
    BlueprintStep,
    BlueprintStepMetric,
    LLMStep,
} from '@libs/shared/blueprint/blueprint.types';

import { BaseAgentProvider } from '../infrastructure/services/kodus-flow/base-agent.provider';
import { GenericSkillRunnerService } from './generic-skill-runner.service';
import { buildCapabilityHooks } from './runtime/capability-hooks.factory';
import { CapabilityResourcePlanService } from './runtime/capability-resource-plan.service';
import { CapabilityStrategyService } from './runtime/capability-strategy.service';
import {
    CapabilityExecutionHooks,
    CapabilityExecutionTrace,
    SkillCapabilityRuntimeConfig,
    ToolCaller,
} from './runtime/skill-runtime.types';

export interface SkillExecutionContext<TPrepareContext = unknown> {
    organizationAndTeamData: OrganizationAndTeamData;
    prepareContext?: TPrepareContext;
    thread?: Thread;
    /**
     * Per-repository/directory BYOK model override resolved by the code
     * review pipeline (`codeReviewConfig.byokModel`). When set, the skill's
     * LLM calls run on this model instead of the BYOK-settings main model.
     */
    byokModel?: string;
}

export interface SkillErrorContext<TPrepareContext = unknown> {
    userLanguage: string;
    context: SkillExecutionContext<TPrepareContext>;
    error: unknown;
}

export interface SkillFeedbackContext<TPrepareContext = unknown> {
    userLanguage: string;
    context: SkillExecutionContext<TPrepareContext>;
    feedback: string;
}

export abstract class AbstractSkillProvider<
    TContext extends BlueprintContext & {
        capabilityExecutionTrace?: CapabilityExecutionTrace[];
    },
    TPrepareContext = unknown,
> extends BaseAgentProvider {
    private readonly runtimeLogger = createLogger(this.constructor.name);

    protected abstract readonly skillName: string;

    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        protected readonly genericSkillRunner: GenericSkillRunnerService,
        protected readonly metricsCollector?: MetricsCollectorService,
        protected readonly capabilityStrategyService?: CapabilityStrategyService,
        protected readonly capabilityResourcePlanService?: CapabilityResourcePlanService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
    }

    protected abstract createBlueprint(
        fetcher: ToolCaller,
        capabilityRuntime: SkillCapabilityRuntimeConfig,
        hooks?: CapabilityExecutionHooks<TContext>,
    ): BlueprintStep<TContext>[];

    protected abstract runLLMStep(
        step: LLMStep,
        ctx: TContext,
    ): Promise<TContext>;

    protected abstract createInitialContext(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: TPrepareContext;
        thread?: Thread;
        userLanguage: string;
    }): TContext;

    protected abstract resolveUserLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string>;

    protected resolveTaskContextMode(
        _ctx: TContext,
        _providerType: string,
    ): 'cache_first' | 'agent_first' {
        return 'cache_first';
    }

    protected onFetcherInitializationError(
        _params: SkillErrorContext<TPrepareContext>,
    ): string | undefined {
        return undefined;
    }

    protected onBlueprintExecutionError(
        _params: SkillErrorContext<TPrepareContext>,
    ): string | undefined {
        return undefined;
    }

    protected extractResponse(ctx: TContext): string {
        const formatted = (ctx as { formattedResponse?: string })
            .formattedResponse;
        return typeof formatted === 'string' ? formatted : '';
    }

    protected async formatExecutionFeedback(
        params: SkillFeedbackContext<TPrepareContext>,
    ): Promise<string> {
        return params.feedback;
    }

    protected async buildResponse(ctx: TContext): Promise<string> {
        return this.extractResponse(ctx);
    }

    async execute(
        context: SkillExecutionContext<TPrepareContext>,
    ): Promise<string> {
        const organizationAndTeamData = context.organizationAndTeamData;
        if (!organizationAndTeamData) {
            throw new Error(
                'Organization and team data is required for skill execution.',
            );
        }

        const userLanguage = await this.resolveUserLanguage(
            organizationAndTeamData,
        );

        this.logExecutionStarted(organizationAndTeamData, userLanguage);

        await this.fetchBYOKConfig(organizationAndTeamData, context.byokModel);

        const fetcherInitialization = await this.initializeFetcherRuntime(
            context,
            organizationAndTeamData,
            userLanguage,
        );
        if (fetcherInitialization.feedback) {
            return this.formatExecutionFeedback({
                userLanguage,
                context,
                feedback: fetcherInitialization.feedback,
            });
        }
        const fetcherRuntime = fetcherInitialization.runtime;

        const initialCtx = this.createInitialContext({
            organizationAndTeamData,
            prepareContext: context.prepareContext,
            thread: context.thread,
            userLanguage,
        });

        const capabilityRuntimeConfig = fetcherRuntime.capabilityRuntime;
        const capabilityHooks = buildCapabilityHooks<TContext>({
            strategyService: this.capabilityStrategyService,
            resourcePlanService: this.capabilityResourcePlanService,
            resolveTaskContextMode: (ctx, providerType) =>
                this.resolveTaskContextMode(ctx, providerType),
            recordExecution: (trace) => this.recordCapabilityExecution(trace),
        });

        const blueprintExecution = await this.executeBlueprintWithHandling(
            context,
            initialCtx,
            fetcherRuntime.toolCaller,
            capabilityRuntimeConfig,
            capabilityHooks,
            organizationAndTeamData,
            userLanguage,
        );
        if (blueprintExecution.feedback) {
            return this.formatExecutionFeedback({
                userLanguage,
                context,
                feedback: blueprintExecution.feedback,
            });
        }
        const result = blueprintExecution.result;
        const response = await this.buildResponse(result.context);

        this.logExecutionCompleted(result, organizationAndTeamData, response);

        const traces = result.context.capabilityExecutionTrace ?? [];
        if (traces.length > 0) {
            this.logCapabilityTraces(traces, organizationAndTeamData);
        }

        return response;
    }

    private async initializeFetcherRuntime(
        context: SkillExecutionContext<TPrepareContext>,
        organizationAndTeamData: OrganizationAndTeamData,
        userLanguage: string,
    ): Promise<
        | {
              runtime: Awaited<
                  ReturnType<
                      GenericSkillRunnerService['createFetcherOrchestration']
                  >
              >;
              feedback?: undefined;
          }
        | {
              runtime?: undefined;
              feedback: string;
          }
    > {
        try {
            return {
                runtime:
                    await this.genericSkillRunner.createFetcherOrchestration(
                        this.skillName,
                        super.createLLMAdapter(
                            this.constructor.name,
                            `${this.skillName}-fetcher`,
                        ),
                        organizationAndTeamData,
                    ),
            };
        } catch (error) {
            const feedback = this.onFetcherInitializationError({
                userLanguage,
                context,
                error,
            });
            if (feedback) {
                return { feedback };
            }
            throw error;
        }
    }

    private async executeBlueprintWithHandling(
        context: SkillExecutionContext<TPrepareContext>,
        initialCtx: TContext,
        toolCaller: ToolCaller,
        capabilityRuntimeConfig: SkillCapabilityRuntimeConfig,
        capabilityHooks: CapabilityExecutionHooks<TContext>,
        organizationAndTeamData: OrganizationAndTeamData,
        userLanguage: string,
    ): Promise<
        | {
              result: Awaited<ReturnType<typeof runBlueprint<TContext>>>;
              feedback?: undefined;
          }
        | {
              result?: undefined;
              feedback: string;
          }
    > {
        try {
            return {
                result: await runBlueprint<TContext>({
                    steps: this.createBlueprint(
                        toolCaller,
                        capabilityRuntimeConfig,
                        capabilityHooks,
                    ),
                    context: initialCtx,
                    runLLMStep: (step, ctx) => this.runLLMStep(step, ctx),
                    onStepMetric: (metric) =>
                        this.recordStepMetric(metric, organizationAndTeamData),
                    logger: {
                        log: (msg) =>
                            this.runtimeLogger.log({
                                message: msg,
                                context: this.constructor.name,
                                serviceName: this.constructor.name,
                            }),
                        error: (msg, err) =>
                            this.runtimeLogger.error({
                                message: msg,
                                context: this.constructor.name,
                                serviceName: this.constructor.name,
                                metadata: { error: err },
                            }),
                    },
                }),
            };
        } catch (error) {
            if (error instanceof BlueprintStepContractViolationError) {
                this.runtimeLogger.error({
                    message:
                        'Skill execution failed due to blueprint step contract violation',
                    context: this.constructor.name,
                    serviceName: this.constructor.name,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        skill: this.skillName,
                        stepName: error.stepName,
                        stage: error.stage,
                        details: error.details,
                    },
                });
            }

            const feedback = this.onBlueprintExecutionError({
                userLanguage,
                context,
                error,
            });
            if (feedback) {
                return { feedback };
            }
            throw error;
        }
    }

    private logExecutionStarted(
        organizationAndTeamData: OrganizationAndTeamData,
        userLanguage: string,
    ): void {
        this.runtimeLogger.log({
            message: `${this.skillName} execution started`,
            context: this.constructor.name,
            serviceName: this.constructor.name,
            metadata: {
                skill: this.skillName,
                userLanguage,
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            },
        });
    }

    private logExecutionCompleted(
        result: Awaited<ReturnType<typeof runBlueprint<TContext>>>,
        organizationAndTeamData: OrganizationAndTeamData,
        response: string,
    ): void {
        this.runtimeLogger.log({
            message: `${this.skillName} execution completed`,
            context: this.constructor.name,
            serviceName: this.constructor.name,
            metadata: {
                skill: this.skillName,
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                completedSteps: result.completedSteps,
                skippedAt: result.skippedAt,
                responseLength: response.length,
            },
        });
    }

    private logCapabilityTraces(
        traces: CapabilityExecutionTrace[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): void {
        this.runtimeLogger.log({
            message: 'Capability execution traces',
            context: this.constructor.name,
            serviceName: this.constructor.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                skill: this.skillName,
                traceCount: traces.length,
                traces: traces.map((trace) => ({
                    capability: trace.capability,
                    mode: trace.mode,
                    provider: trace.provider,
                    tool: trace.toolName,
                    status: trace.status,
                    reason: trace.reason,
                    latencyMs: trace.latencyMs,
                })),
            },
        });
    }

    protected async recordCapabilityExecution(
        trace: CapabilityExecutionTrace,
    ): Promise<void> {
        if (!this.capabilityStrategyService) {
            return;
        }

        await this.capabilityStrategyService.recordExecution(trace);

        const labels = {
            skill: trace.skillName,
            capability: trace.capability,
            provider: trace.provider,
            mode: trace.mode,
            status: trace.status,
            toolName: trace.toolName ?? 'none',
            reason: trace.reason ?? 'none',
        };

        this.metricsCollector?.recordCounter(
            'kodus_skill_capability_execution_total',
            1,
            labels,
        );
        this.metricsCollector?.recordHistogram(
            'kodus_skill_capability_execution_duration_ms',
            trace.latencyMs,
            labels,
        );
    }

    protected recordStepMetric(
        metric: BlueprintStepMetric,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const labels = {
            skill: this.skillName,
            step: metric.stepName,
            stepType: metric.stepType,
            status: metric.status,
        };

        this.metricsCollector?.recordHistogram(
            'kodus_skill_step_duration_ms',
            metric.durationMs,
            labels,
        );
        this.metricsCollector?.recordCounter(
            'kodus_skill_step_total',
            1,
            labels,
        );

        this.runtimeLogger.log({
            message: 'Skill step metric',
            context: this.constructor.name,
            serviceName: this.constructor.name,
            metadata: {
                ...labels,
                durationMs: metric.durationMs,
                organizationId: organizationAndTeamData?.organizationId,
                teamId: organizationAndTeamData?.teamId,
                ...(metric.errorMessage
                    ? { errorMessage: metric.errorMessage }
                    : {}),
            },
        });
    }
}
