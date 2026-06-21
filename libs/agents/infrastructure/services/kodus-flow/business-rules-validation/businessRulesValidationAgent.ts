import {
    AgentInputEnum,
    LLMAdapter,
    LLMRequest,
    Thread,
    createLogger,
} from '@kodus/flow';
import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable, Inject, Optional } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    PARAMETERS_SERVICE_TOKEN,
    IParametersService,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ObservabilityService } from '@libs/core/log/observability.service';

import { BlueprintStepContractViolationError } from '@libs/shared/blueprint/blueprint.runner';
import { BlueprintStep, LLMStep } from '@libs/shared/blueprint/blueprint.types';
import { GenericSkillRunnerService } from '../../../../skills/generic-skill-runner.service';
import { CapabilityStrategyService } from '../../../../skills/runtime/capability-strategy.service';
import { CapabilityResourcePlanService } from '../../../../skills/runtime/capability-resource-plan.service';
import {
    CapabilityExecutionHooks,
    SkillCapabilityRuntimeConfig,
    ToolCaller,
} from '../../../../skills/runtime/skill-runtime.types';
import { asRecord } from '../../../../skills/runtime/value-utils';
import {
    isMcpConnectivityError,
    McpConnectionUnavailableError,
    RequiredMcpPreflightError,
} from '../../../../skills/skill.errors';
import { createBusinessRulesBlueprint } from './blueprint';
import {
    buildMcpConnectionFailureFeedback,
} from './required-mcp-feedback';
import {
    BusinessRulesContext,
    BusinessRulesPrepareContext,
    ValidationResult,
} from './types';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import {
    AbstractSkillProvider,
    SkillFeedbackContext,
    SkillErrorContext,
} from '../../../../skills/abstract-skill-provider';
import { buildBusinessRulesAnalysisPrompt } from './analysis-prompt.builder';
import { buildBusinessRulesContractViolationFeedback } from './contract-feedback.builder';
import { parseBusinessRulesValidationResult } from './validation-result.parser';

const SKILL_NAME = 'business-rules-validation';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_NEEDS_MORE_INFO_MESSAGE =
    '## 🤔 Need Task Information\n\nPlease provide task context.';
const PARSER_FALLBACK_FRAGMENT = 'error parsing validation result';

type AnalyzerAdapter = Pick<LLMAdapter, 'call'>;

/** Re-exported for backward compatibility with callers that imported from here */
export type { ValidationResult };

@Injectable()
export class BusinessRulesValidationAgentProvider extends AbstractSkillProvider<
    BusinessRulesContext,
    BusinessRulesPrepareContext
> {
    /** Returned when no task-management MCP is connected so the pipeline
     *  stage can silently skip without posting any PR comment. */
    static readonly NO_TASK_MCP_SENTINEL = '__NO_TASK_MCP__';

    private readonly logger = createLogger(
        BusinessRulesValidationAgentProvider.name,
    );

    protected readonly skillName = SKILL_NAME;

    protected readonly defaultLLMConfig = {
        llmProvider: LLMModelProvider.GEMINI_2_5_PRO,
        temperature: 0,
        maxTokens: 20000,
        maxReasoningTokens: 1024,
        stop: undefined as string[] | undefined,
    };

    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        observabilityService: ObservabilityService,
        genericSkillRunner: GenericSkillRunnerService,
        @Optional() metricsCollector?: MetricsCollectorService,
        @Optional() capabilityStrategyService?: CapabilityStrategyService,
        @Optional()
        capabilityResourcePlanService?: CapabilityResourcePlanService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
            genericSkillRunner,
            metricsCollector,
            capabilityStrategyService,
            capabilityResourcePlanService,
        );
    }

    protected createBlueprint(
        fetcher: ToolCaller,
        capabilityRuntime: SkillCapabilityRuntimeConfig,
        hooks?: CapabilityExecutionHooks<BusinessRulesContext>,
    ): BlueprintStep<BusinessRulesContext>[] {
        return createBusinessRulesBlueprint(fetcher, capabilityRuntime, hooks);
    }

    protected runLLMStep(
        step: LLMStep,
        ctx: BusinessRulesContext,
    ): Promise<BusinessRulesContext> {
        return this.runAnalyzer(step, ctx);
    }

    protected createInitialContext(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: BusinessRulesPrepareContext;
        thread?: Thread;
        userLanguage: string;
    }): BusinessRulesContext {
        return {
            organizationAndTeamData: params.organizationAndTeamData,
            userLanguage: params.userLanguage,
            thread: params.thread,
            prepareContext: params.prepareContext,
        };
    }

    protected resolveTaskContextMode(
        ctx: BusinessRulesContext,
    ): 'cache_first' | 'agent_first' {
        return ctx.prepareContext?.taskContextResolutionMode ?? 'cache_first';
    }

    protected resolveUserLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        return this.getLanguage(organizationAndTeamData);
    }

    protected onFetcherInitializationError(
        params: SkillErrorContext<BusinessRulesPrepareContext>,
    ): string | undefined {
        const { error, userLanguage, context } = params;

        if (error instanceof RequiredMcpPreflightError) {
            const requiredLabels = (error.requiredMcps ?? [])
                .map((m: any) => m?.label || m?.category || 'unknown')
                .join(', ');
            const availableProviders = error.availableProviders ?? [];
            this.logger.warn({
                message: `Business rules validation skipped — required MCP integrations missing: [${requiredLabels || 'unknown'}]. Available providers: [${availableProviders.join(', ') || 'none'}]`,
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    requiredMcps: error.requiredMcps,
                    availableProviders,
                },
            });

            return BusinessRulesValidationAgentProvider.NO_TASK_MCP_SENTINEL;
        }

        if (error instanceof McpConnectionUnavailableError) {
            const feedback = buildMcpConnectionFailureFeedback({
                userLanguage,
                availableProviders: error.availableProviders,
            });

            const availableProviders = error.availableProviders ?? [];
            this.logger.warn({
                message: `Business rules validation skipped due to MCP connection failure during fetcher initialization — available providers: [${availableProviders.join(', ') || 'none'}]`,
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    availableProviders,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                },
            });

            return feedback;
        }

        return undefined;
    }

    protected onBlueprintExecutionError(
        params: SkillErrorContext<BusinessRulesPrepareContext>,
    ): string | undefined {
        const { error, userLanguage, context } = params;

        if (
            error instanceof McpConnectionUnavailableError ||
            isMcpConnectivityError(error)
        ) {
            const feedback = buildMcpConnectionFailureFeedback({
                userLanguage,
                availableProviders:
                    error instanceof McpConnectionUnavailableError
                        ? error.availableProviders
                        : undefined,
            });

            this.logger.warn({
                message:
                    'Business rules validation failed due to MCP connection error while executing blueprint',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                },
            });

            return feedback;
        }

        if (error instanceof BlueprintStepContractViolationError) {
            return buildBusinessRulesContractViolationFeedback(
                userLanguage,
                error.stage,
                [error.details],
            );
        }

        return undefined;
    }

    protected async formatExecutionFeedback(
        params: SkillFeedbackContext<BusinessRulesPrepareContext>,
    ): Promise<string> {
        return this.formatUserFacingMessage(
            params.feedback,
            params.userLanguage,
            'feedback',
        );
    }

    protected async buildResponse(ctx: BusinessRulesContext): Promise<string> {
        if (ctx.validationResult) {
            return this.formatValidationResponse(ctx.validationResult, ctx);
        }

        return super.buildResponse(ctx);
    }

    private async runAnalyzer(
        _step: LLMStep,
        ctx: BusinessRulesContext,
    ): Promise<BusinessRulesContext> {
        const executionPolicy =
            this.genericSkillRunner.getExecutionPolicy(SKILL_NAME);
        const analyzerContext = this.buildAnalyzerInstructionContext(ctx);
        const analyzerInstructions =
            this.genericSkillRunner.getAnalyzerInstructions(
                SKILL_NAME,
                analyzerContext,
            );
        const analyzerAdapter = super.createLLMAdapter(
            'BusinessRulesValidation',
            'businessRulesAnalyzer',
        );
        const prompt = buildBusinessRulesAnalysisPrompt(ctx);
        const maxAttempts = Math.max(1, executionPolicy.analyzerMaxIterations);
        const validationResult = await this.executeAnalyzerWithRetries({
            ctx,
            analyzerAdapter,
            analyzerInstructions,
            prompt,
            maxAttempts,
            timeoutMs: executionPolicy.analyzerTimeoutMs,
        });
        const normalizedValidationResult = this.applyValidationDefaults(
            validationResult,
            ctx,
        );
        this.recordValidationOutcomeMetric(ctx, normalizedValidationResult);
        const formattedResponse = await this.formatValidationResponse(
            normalizedValidationResult,
            ctx,
        );

        return {
            ...ctx,
            validationResult: normalizedValidationResult,
            formattedResponse,
        };
    }

    private isParserFallback(result: ValidationResult): boolean {
        if (!result.needsMoreInfo) {
            return false;
        }

        if (result.reason === 'parser_fallback') {
            return true;
        }

        const message = (result.missingInfo ?? '').toLowerCase();
        return message.includes(PARSER_FALLBACK_FRAGMENT);
    }

    private async withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        label: string,
    ): Promise<T> {
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<T>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Timeout after ${timeoutMs}ms in ${label}`));
            }, timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    private resolveAnalyzerCustomInstructions(
        ctx: BusinessRulesContext,
    ): string | undefined {
        const value = ctx.prepareContext?.customInstructions;
        return typeof value === 'string' && value.trim().length > 0
            ? value
            : undefined;
    }

    protected async createMCPAdapter(
        _organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {}

    private parseValidationResult(result: unknown): ValidationResult {
        return parseBusinessRulesValidationResult(result);
    }

    private buildAnalyzerInstructionContext(ctx: BusinessRulesContext): {
        organizationId?: string;
        teamId?: string;
        customInstructions?: string;
    } {
        return {
            organizationId: ctx.organizationAndTeamData?.organizationId,
            teamId: ctx.organizationAndTeamData?.teamId,
            customInstructions: this.resolveAnalyzerCustomInstructions(ctx),
        };
    }

    private async executeAnalyzerWithRetries(params: {
        ctx: BusinessRulesContext;
        analyzerAdapter: AnalyzerAdapter;
        analyzerInstructions: string;
        prompt: string;
        maxAttempts: number;
        timeoutMs: number;
    }): Promise<ValidationResult> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= params.maxAttempts; attempt += 1) {
            try {
                const validationResult = await this.executeAnalyzerAttempt({
                    ctx: params.ctx,
                    analyzerAdapter: params.analyzerAdapter,
                    analyzerInstructions: params.analyzerInstructions,
                    prompt: params.prompt,
                    attempt,
                    timeoutMs: params.timeoutMs,
                });

                if (
                    !this.isParserFallback(validationResult) ||
                    attempt === params.maxAttempts
                ) {
                    return validationResult;
                }
            } catch (error) {
                lastError = error;
                if (attempt === params.maxAttempts) {
                    break;
                }
            }
        }

        return this.buildAnalyzerFailureResult(lastError);
    }

    private async executeAnalyzerAttempt(params: {
        ctx: BusinessRulesContext;
        analyzerAdapter: AnalyzerAdapter;
        analyzerInstructions: string;
        prompt: string;
        attempt: number;
        timeoutMs: number;
    }): Promise<ValidationResult> {
        const analysisResult = await this.withTimeout(
            params.analyzerAdapter.call({
                messages: this.buildAnalyzerMessages(
                    params.analyzerInstructions,
                    params.prompt,
                ),
                temperature: this.defaultLLMConfig.temperature,
                maxTokens: this.defaultLLMConfig.maxTokens,
                maxReasoningTokens: this.defaultLLMConfig.maxReasoningTokens,
                stop: this.defaultLLMConfig.stop,
            }),
            params.timeoutMs,
            `business-rules-analyzer-attempt-${params.attempt}`,
        );

        this.logAnalyzerUsage(params.ctx, params.attempt, analysisResult);

        return this.parseValidationResult(analysisResult.content);
    }

    private buildAnalyzerMessages(
        analyzerInstructions: string,
        prompt: string,
    ): LLMRequest['messages'] {
        return [
            {
                role: AgentInputEnum.SYSTEM,
                content: analyzerInstructions,
            },
            {
                role: AgentInputEnum.USER,
                content: prompt,
            },
        ];
    }

    private logAnalyzerUsage(
        ctx: BusinessRulesContext,
        attempt: number,
        analysisResult: { usage?: unknown },
    ): void {
        const usage = asRecord(analysisResult.usage);
        const tokensIn =
            typeof usage.promptTokens === 'number' ? usage.promptTokens : 0;
        const tokensOut =
            typeof usage.completionTokens === 'number'
                ? usage.completionTokens
                : 0;
        const totalTokens =
            typeof usage.totalTokens === 'number'
                ? usage.totalTokens
                : tokensIn + tokensOut;

        this.logger.log({
            message: 'Business rules analyzer token usage',
            context: BusinessRulesValidationAgentProvider.name,
            serviceName: BusinessRulesValidationAgentProvider.name,
            metadata: {
                attempt,
                tokensIn,
                tokensOut,
                totalTokens,
                organizationId: ctx.organizationAndTeamData?.organizationId,
                teamId: ctx.organizationAndTeamData?.teamId,
            },
        });
    }

    private buildAnalyzerFailureResult(lastError: unknown): ValidationResult {
        return {
            needsMoreInfo: true,
            mode: 'limitation_response',
            reason: 'analyzer_failure',
            confidence: 'low',
            missingInfo:
                lastError instanceof Error
                    ? `Analyzer execution failed: ${lastError.message}`
                    : 'Analyzer execution failed.',
            summary:
                '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.',
        };
    }

    private applyValidationDefaults(
        result: ValidationResult,
        ctx: BusinessRulesContext,
    ): ValidationResult {
        const eligibility = ctx.analysisEligibility;
        const mode =
            result.mode ??
            (result.needsMoreInfo
                ? 'limitation_response'
                : (eligibility?.mode ?? 'full_analysis'));
        const reason =
            result.reason ??
            (result.needsMoreInfo
                ? eligibility?.reason
                : (eligibility?.reason ?? 'analysis_ready'));
        const taskContextStatus =
            result.taskContextStatus ?? eligibility?.taskContextStatus;
        const prDiffStatus = result.prDiffStatus ?? eligibility?.prDiffStatus;
        const confidence =
            result.confidence ??
            (mode === 'limitation_response' ? 'low' : 'medium');

        return {
            ...result,
            mode,
            reason,
            taskContextStatus,
            prDiffStatus,
            confidence,
        };
    }

    /** Metadata markers embedded at the top of the response so the
     *  pipeline stage can make structured decisions without parsing
     *  natural-language text. */
    static readonly WEAK_TASK_CONTEXT_MARKER =
        '<!-- task_context_status:weak -->';

    private async formatValidationResponse(
        result: ValidationResult,
        ctx: BusinessRulesContext,
    ): Promise<string> {
        if (result.needsMoreInfo) {
            let limitationMessage = result.summary?.trim();
            const diagnostic = result.missingInfo?.trim();
            const shouldAppendDiagnostic =
                (result.reason === 'analyzer_failure' ||
                    result.reason === 'parser_fallback') &&
                typeof diagnostic === 'string' &&
                diagnostic.length > 0 &&
                !limitationMessage?.includes(diagnostic);

            if (shouldAppendDiagnostic) {
                limitationMessage = limitationMessage
                    ? `${limitationMessage}\n\n### Details\n- ${diagnostic}`
                    : diagnostic;
            }

            const rawMessage = limitationMessage
                ? await this.formatUserFacingMessage(
                      limitationMessage,
                      ctx.userLanguage,
                      'limitation',
                  )
                : await this.formatUserFacingMessage(
                      result.missingInfo ?? DEFAULT_NEEDS_MORE_INFO_MESSAGE,
                      ctx.userLanguage,
                      'limitation',
                  );

            // Embed a marker so the pipeline stage can detect weak task
            // context without relying on natural-language matching.
            if (
                result.taskContextStatus === 'weak' ||
                result.taskContextStatus === 'missing'
            ) {
                return `${BusinessRulesValidationAgentProvider.WEAK_TASK_CONTEXT_MARKER}\n${rawMessage}`;
            }

            return rawMessage;
        }

        return result.summary ?? '';
    }

    private async formatUserFacingMessage(
        message: string,
        userLanguage: string,
        mode: 'feedback' | 'limitation',
    ): Promise<string> {
        if (typeof message !== 'string' || message.trim().length === 0) {
            return message;
        }

        if (
            userLanguage.trim().toLowerCase() === DEFAULT_LANGUAGE.toLowerCase()
        ) {
            return message;
        }

        try {
            const adapter = super.createLLMAdapter(
                'BusinessRulesValidation',
                'businessRulesUserFacingFormatter',
            );
            const formatted = await adapter.call({
                messages: [
                    {
                        role: AgentInputEnum.SYSTEM,
                        content:
                            'Rewrite the provided markdown for the end user in the requested USER LANGUAGE. Preserve markdown structure, code spans, links, and bullet lists. Preserve quoted requirement text exactly when it is explicitly quoted from task context. Do not add new information.',
                    },
                    {
                        role: AgentInputEnum.USER,
                        content: `USER LANGUAGE: ${userLanguage}\nMODE: ${mode}\n\nMESSAGE:\n${message}`,
                    },
                ],
                temperature: 0,
                maxTokens: 1200,
                maxReasoningTokens: 1024,
                stop: undefined,
            });

            return typeof formatted.content === 'string' &&
                formatted.content.trim().length > 0
                ? formatted.content.trim()
                : message;
        } catch {
            return message;
        }
    }

    private recordValidationOutcomeMetric(
        ctx: BusinessRulesContext,
        result: ValidationResult,
    ): void {
        const labels = {
            skill: SKILL_NAME,
            mode: result.mode ?? 'unknown',
            reason: result.reason ?? 'unknown',
            taskContextStatus: result.taskContextStatus ?? 'unknown',
            prDiffStatus: result.prDiffStatus ?? 'unknown',
            confidence: result.confidence ?? 'unknown',
        };

        this.metricsCollector?.recordCounter(
            'kodus_business_logic_validation_outcome_total',
            1,
            labels,
        );

        this.logger.log({
            message: 'Business logic validation outcome',
            context: BusinessRulesValidationAgentProvider.name,
            serviceName: BusinessRulesValidationAgentProvider.name,
            metadata: {
                ...labels,
                organizationId: ctx.organizationAndTeamData?.organizationId,
                teamId: ctx.organizationAndTeamData?.teamId,
            },
        });
    }

    private async getLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        if (!organizationAndTeamData?.teamId) {
            return DEFAULT_LANGUAGE;
        }

        try {
            const language = await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            );
            return language?.configValue ?? DEFAULT_LANGUAGE;
        } catch {
            return DEFAULT_LANGUAGE;
        }
    }
}
