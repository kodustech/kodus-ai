import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable, Inject, Optional } from '@nestjs/common';

import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import { finalText } from '@libs/agent-harness/domain/run-state.util';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { buildLangfuseTelemetry } from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { resolveAgentModel } from '@libs/llm/agent-model';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';

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
    AgentThread,
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
import {
    applyBusinessRulesVerdict,
    BusinessRulesVerifier,
    shouldVerifyValidationResult,
} from './business-rules-verifier';

const SKILL_NAME = 'business-rules-validation';
const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_NEEDS_MORE_INFO_MESSAGE =
    '## 🤔 Need Task Information\n\nPlease provide task context.';
const PARSER_FALLBACK_FRAGMENT = 'error parsing validation result';

/**
 * Chat message for the analyzer LLM call. Replaces the legacy flow engine's
 * `LLMRequest['messages']` + `AgentInputEnum` — typed locally so this agent
 * has no flow-engine dependency.
 */
type AnalyzerMessage = { role: 'system' | 'user'; content: string };

/** Result shape of a single analyzer LLM call (mirrors the legacy adapter's
 *  `{ content, usage }`). */
interface AnalyzerCallResult {
    content: string;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    };
}

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
        @Optional() private readonly byokErrorCounter?: ByokErrorCounter,
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
        thread?: AgentThread;
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
        const prompt = buildBusinessRulesAnalysisPrompt(ctx);
        const maxAttempts = Math.max(1, executionPolicy.analyzerMaxIterations);
        const validationResult = await this.executeAnalyzerWithRetries({
            ctx,
            analyzerInstructions,
            prompt,
            maxAttempts,
            timeoutMs: executionPolicy.analyzerTimeoutMs,
        });
        // Optional second pass: an independent Verifier (doer≠checker) refutes a
        // claimed violation the analyzer may have over-flagged. OFF by default —
        // see SkillExecutionPolicy.verifyAnalyzerResult; no-op until opted in.
        const verifiedResult = await this.maybeVerifyValidationResult(
            validationResult,
            ctx,
            executionPolicy,
        );
        const normalizedValidationResult = this.applyValidationDefaults(
            verifiedResult,
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

    /**
     * Independent verify pass (doer≠checker). When opted in
     * (SkillExecutionPolicy.verifyAnalyzerResult) and the analysis concluded, an
     * LLM Verifier refutes the analyzer's claimed violation; a refuted claim is
     * dropped (applyBusinessRulesVerdict). OFF by default and fully fail-open: a
     * verify error returns the analyzer's result untouched. Reuses the same model
     * setup + run-context guarantees as the analyzer.
     */
    private async maybeVerifyValidationResult(
        result: ValidationResult,
        ctx: BusinessRulesContext,
        policy: { verifyAnalyzerResult?: boolean; analyzerTimeoutMs: number },
    ): Promise<ValidationResult> {
        if (!shouldVerifyValidationResult(result, policy)) {
            return result;
        }
        const orgId =
            ctx.organizationAndTeamData?.organizationId?.toString();
        const teamId = ctx.organizationAndTeamData?.teamId?.toString();
        try {
            const model = resolveAgentModel(this.byokConfig, {
                organizationId: orgId,
                provider: this.byokConfig?.main?.provider,
                reporter: this.byokErrorCounter
                    ? (e) => void this.byokErrorCounter!.record(e)
                    : undefined,
            });
            const runner = new AiSdkAgentRunner({ resolve: () => model });
            const verifier = new BusinessRulesVerifier(runner, {
                modelId: 'resolved',
                diff: ctx.prDiff ?? '',
                taskContext: ctx.taskContext ?? '',
                userLanguage: ctx.userLanguage,
                telemetryMetadata: {
                    organizationId: orgId,
                    teamId,
                    provider: this.byokConfig?.main?.provider,
                },
            });
            const { ctx: runCtx, cleanup } = createAgentRunContext({
                runId: 'business-rules:verify',
                timeoutMs: policy.analyzerTimeoutMs,
            });
            try {
                const verdict = await verifier.verify(result, runCtx);
                // Verify cost → Mongo observability_telemetry, same canonical
                // emitter/schema as the analyzer (just a distinct phase) so the
                // verify pass's tokens are billed, not invisible.
                const u = verifier.usage;
                await this.observabilityService.recordAgentRunUsage({
                    agentName: 'BusinessRulesValidation',
                    phase: 'businessRulesVerify',
                    runName: 'businessRulesVerify',
                    model: this.byokConfig?.main?.model,
                    isByok: !!this.byokConfig,
                    usage: {
                        inputTokens: u.inputTokens,
                        outputTokens: u.outputTokens,
                        totalTokens:
                            (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
                        reasoningTokens: u.reasoningTokens,
                        cacheReadTokens: u.cacheReadTokens,
                    },
                    organizationId: orgId,
                    teamId,
                });
                return applyBusinessRulesVerdict(result, verdict);
            } finally {
                cleanup();
            }
        } catch (error) {
            // Fail-open: the verify pass never drops a result by erroring.
            this.logger.warn({
                message: `business-rules verify pass failed; keeping analyzer result: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: { organizationId: orgId, teamId },
            });
            return result;
        }
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
        analyzerInstructions: string;
        prompt: string;
        attempt: number;
        timeoutMs: number;
    }): Promise<ValidationResult> {
        const analysisResult = await this.withTimeout(
            this.callLLM(
                this.buildAnalyzerMessages(
                    params.analyzerInstructions,
                    params.prompt,
                ),
                {
                    temperature: this.defaultLLMConfig.temperature,
                    maxTokens: this.defaultLLMConfig.maxTokens,
                },
                'businessRulesAnalyzer',
                this.telemetryMetadataFromCtx(params.ctx),
            ),
            params.timeoutMs,
            `business-rules-analyzer-attempt-${params.attempt}`,
        );

        this.logAnalyzerUsage(params.ctx, params.attempt, analysisResult);

        return this.parseValidationResult(analysisResult.content);
    }

    /**
     * Run a single LLM completion on the Vercel AI SDK. Replaces the legacy
     * `super.createLLMAdapter(...).call(...)` (the legacy flow-engine LLM bridge):
     * `byokToVercelModel` resolves the BYOK model and `generateText` runs a
     * plain (no-tools) completion. Langfuse parity via `buildLangfuseTelemetry`.
     */
    /**
     * Telemetry metadata (org/team/PR/repo) for Langfuse so the analyzer +
     * formatter traces group under the SAME `org:repo:pr` session as the
     * code-review agents — parity, instead of landing outside the PR session.
     */
    private telemetryMetadataFromCtx(ctx: BusinessRulesContext): {
        organizationId?: string;
        teamId?: string;
        pullRequestId?: number;
        repositoryId?: string;
    } {
        const pc = ctx.prepareContext;
        const repoId = pc?.repository?.id;
        return {
            organizationId:
                ctx.organizationAndTeamData?.organizationId?.toString(),
            teamId: ctx.organizationAndTeamData?.teamId?.toString(),
            pullRequestId:
                pc?.pullRequestNumber ?? pc?.pullRequest?.pullRequestNumber,
            repositoryId: repoId != null ? String(repoId) : undefined,
        };
    }

    private async callLLM(
        messages: AnalyzerMessage[],
        options: { temperature?: number; maxTokens?: number },
        functionId: string,
        metadata?: {
            organizationId?: string;
            teamId?: string;
            // Forwarded to Langfuse so the analyzer trace groups under the SAME
            // PR session as the code-review agents (which pass the full PR/repo
            // context). Without these, the business-rules trace lands outside the
            // org:repo:pr session and looks "missing" in the sessions view.
            pullRequestId?: number;
            repositoryId?: string;
        },
    ): Promise<AnalyzerCallResult> {
        // Standard model setup (same as every agent): BYOK resolve + concurrency
        // limiter + failure reporter.
        const model = resolveAgentModel(this.byokConfig, {
            organizationId: metadata?.organizationId,
            provider: this.byokConfig?.main?.provider,
            reporter: this.byokErrorCounter
                ? (e) => void this.byokErrorCounter!.record(e)
                : undefined,
        });
        const system = messages.find((m) => m.role === 'system')?.content;
        const userTurns = messages.filter((m) => m.role !== 'system');

        // Per-call model params come from the org's saved BYOK config — NOT
        // hardcoded. A fixed `temperature: 0` overrode the config and broke
        // models that only accept their configured value (e.g. kimi-k2.7-code
        // wants 1). For a BYOK model we honor the config (omit when unset →
        // provider default); for a system model we keep the call's option.
        const temperature = this.byokConfig?.main
            ? this.byokConfig.main.temperature
            : options.temperature;
        const maxOutputTokens =
            this.byokConfig?.main?.maxOutputTokens ?? options.maxTokens;

        // Thinking/reasoning budget — the effort tier also comes from the BYOK
        // config (the org configured it); fall back to 'low' when unset.
        const providerOptions = buildProviderOptions(functionId, undefined, {
            reasoningEffort: this.byokConfig?.main?.reasoningEffort ?? 'low',
            byokProvider: this.byokConfig?.main?.provider,
            modelName: this.byokConfig?.main?.model,
        });

        // Single runtime: the analysis runs on the harness AiSdkAgentRunner, same
        // engine as code-review/conversation (and as the skill fetcher that
        // gathered the context). No tools, single-shot (maxSteps 1) — a plain
        // completion, but observable as RunState and on one engine. The free-form
        // answer is the last assistant turn (`finalText`).
        const runner = new AiSdkAgentRunner({ resolve: () => model });
        const spec: AgentSpec = {
            id: 'business-rules-analyzer',
            systemPrompt: system ?? '',
            modelId: 'resolved',
            tools: new InMemoryToolRegistry([]),
            policies: [],
            maxSteps: 1,
            ...(typeof temperature === 'number' ? { temperature } : {}),
            ...(maxOutputTokens ? { maxOutputTokens } : {}),
            ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
        };
        const last = userTurns[userTurns.length - 1];
        // userTurns are non-system, i.e. all 'user' (AnalyzerMessage is system|user).
        const seedMessages = userTurns
            .slice(0, -1)
            .map((m) => ({ role: 'user' as const, content: m.content }));

        // Standard run context: signal + hard timeout, same guarantee as the
        // code-review and conversation agents.
        const { ctx, cleanup } = createAgentRunContext({
            runId: `business-rules:${functionId}`,
        });
        let state;
        try {
            state = await runner.run(
                spec,
                {
                    prompt: last?.content ?? '',
                    ...(seedMessages.length ? { seedMessages } : {}),
                    // experimental_telemetry feeds Langfuse (forwarded by the runner).
                    telemetry: buildLangfuseTelemetry(functionId, {
                        organizationId: metadata?.organizationId,
                        teamId: metadata?.teamId,
                        pullRequestId: metadata?.pullRequestId,
                        repositoryId: metadata?.repositoryId,
                        provider: this.byokConfig?.main?.provider,
                    }),
                },
                ctx,
            );
        } finally {
            cleanup();
        }

        const usage = {
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            totalTokens:
                (state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0),
        };

        // Cost -> Mongo `observability_telemetry` via the canonical emitter, so
        // the billing schema (agentName/phase/type/gen_ai.usage.*) is identical
        // to the conversation + code-review agents. Span name parity:
        // `${agentName}::${phase}` == the former `BusinessRulesValidation::${functionId}`.
        await this.observabilityService.recordAgentRunUsage({
            agentName: 'BusinessRulesValidation',
            phase: functionId,
            runName: functionId,
            model: this.byokConfig?.main?.model,
            // Real billing source: a BYOK org runs on its own key -> 'byok'.
            // (The legacy code hardcoded 'system', misattributing BYOK cost.)
            isByok: !!this.byokConfig,
            usage: { ...usage, reasoningTokens: state.usage.reasoningTokens, cacheReadTokens: state.usage.cacheReadTokens },
            organizationId: metadata?.organizationId,
            teamId: metadata?.teamId,
        });

        return { content: finalText(state), usage };
    }

    private buildAnalyzerMessages(
        analyzerInstructions: string,
        prompt: string,
    ): AnalyzerMessage[] {
        return [
            {
                role: 'system',
                content: analyzerInstructions,
            },
            {
                role: 'user',
                content: prompt,
            },
        ];
    }

    private logAnalyzerUsage(
        ctx: BusinessRulesContext,
        attempt: number,
        analysisResult: AnalyzerCallResult,
    ): void {
        const usage = analysisResult.usage;
        const tokensIn = usage?.inputTokens ?? 0;
        const tokensOut = usage?.outputTokens ?? 0;
        const totalTokens = usage?.totalTokens ?? tokensIn + tokensOut;

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

            const formatterMetadata = this.telemetryMetadataFromCtx(ctx);
            const rawMessage = limitationMessage
                ? await this.formatUserFacingMessage(
                      limitationMessage,
                      ctx.userLanguage,
                      'limitation',
                      formatterMetadata,
                  )
                : await this.formatUserFacingMessage(
                      result.missingInfo ?? DEFAULT_NEEDS_MORE_INFO_MESSAGE,
                      ctx.userLanguage,
                      'limitation',
                      formatterMetadata,
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
        metadata?: {
            organizationId?: string;
            teamId?: string;
            pullRequestId?: number;
            repositoryId?: string;
        },
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
            const formatted = await this.callLLM(
                [
                    {
                        role: 'system',
                        content:
                            'Rewrite the provided markdown for the end user in the requested USER LANGUAGE. Preserve markdown structure, code spans, links, and bullet lists. Preserve quoted requirement text exactly when it is explicitly quoted from task context. Do not add new information.',
                    },
                    {
                        role: 'user',
                        content: `USER LANGUAGE: ${userLanguage}\nMODE: ${mode}\n\nMESSAGE:\n${message}`,
                    },
                ],
                { temperature: 0, maxTokens: 1200 },
                'businessRulesUserFacingFormatter',
                metadata,
            );

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
