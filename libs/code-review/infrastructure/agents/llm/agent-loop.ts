import { AsyncLocalStorage } from 'node:async_hooks';

import {
    buildAgentTools,
    type DocumentationSearchAdapter,
} from './agent-tools.factory';
import { attachClassification, classifyLLMError } from './error-classifier';
import { AgentPromptTooLargeError } from './errors';
import type { ReviewWarning } from './review-warnings';
/**
 * Simple agent loop using Vercel AI SDK with native function calling.
 *
 * 1. `generateText` with tools — model investigates using BYOK model
 * 2. Parse JSON from response text — zero cost if model cooperates
 * 3. If JSON parse fails — `generateText` with `Output.object` (cheap model) to structure the text
 */
import {
    generateText as _aiSdkGenerateText,
    stepCountIs,
    hasToolCall,
    Output,
    jsonSchema,
    tool as defineTool,
    type LanguageModel,
} from 'ai';

/**
 * Per-call BYOK error reporting context. Set once at `runAgentLoop`
 * entry; read inside `throttledGenerateText` when a call fails. Using
 * AsyncLocalStorage instead of plumbing the reporter through 9 call
 * sites and 6 helper functions — propagation is implicit across the
 * awaits inside the loop body.
 */
interface ByokErrorReportingContext {
    reporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
    organizationId?: string;
    provider?: string;
}
const byokErrorContext = new AsyncLocalStorage<ByokErrorReportingContext>();

function reportByokError(err: unknown): void {
    const ctx = byokErrorContext.getStore();

    // Classify and attach the canonical category to the error object so
    // downstream catch blocks (e.g. AgentReviewStage iterating
    // result.failures) can read it via getClassification() without
    // re-parsing provider-specific strings. Done before the reporter call
    // so any logging sees the same classified info.
    if (err && typeof err === 'object') {
        attachClassification(err, classifyLLMError(err, ctx?.provider));
    }

    if (!ctx?.reporter || !ctx.provider) return;
    try {
        ctx.reporter({
            organizationId: ctx.organizationId,
            provider: ctx.provider,
            errorMessage:
                err instanceof Error ? err.message : String(err ?? 'unknown'),
        });
    } catch {
        // Never let reporter failures surface — the LLM error is the
        // signal the caller cares about.
    }
}

// Wrap generateText with a hard timeout safety net.
// Some BYOK providers (Synthetic, Z.AI) ignore AbortSignal and hang forever.
// This ensures every LLM call has a maximum wall-clock time.
// Langfuse tracing is consumed via `experimental_telemetry` on each call
// (see `buildLangfuseTelemetry`) and exported through the OTel span
// processor registered in `libs/core/log/langfuse.ts`.
const generateText: typeof _aiSdkGenerateText = (async (
    ...args: Parameters<typeof _aiSdkGenerateText>
) => {
    const opts = args[0] as any;
    const ms =
        opts?.__kodusHardTimeoutMs ??
        (opts?.abortSignal
            ? LLM_CALL_TIMEOUT_MS // secondary calls already set timeoutSignal
            : AGENT_TIMEOUT_MS); // main call uses agent-level timeout
    const label = opts?.experimental_telemetry?.functionId || 'generateText';
    return hardTimeout(_aiSdkGenerateText(...args), ms, label);
}) as typeof _aiSdkGenerateText;

/** Re-export the hard-timeout-wrapped generateText for use outside the agent loop. */
export { generateText as tracedGenerateText };

/**
 * Wraps a generateText call through the BYOK concurrency limiter.
 * When maxConcurrentRequests is configured (e.g. 1 for Z.AI/Synthetic),
 * all LLM calls across all pipelines in this process are serialized.
 */
function throttledGenerateText<T>(params: {
    byokConfig?: BYOKConfig;
    organizationId?: string;
    role?: BYOKLimiterRole;
    label?: string;
    abortSignal?: AbortSignal;
    /** MAINT-02: generic queue timeout forwarded from AgentLoopSecrets.byokQueueTimeoutMs.
     *  When undefined, runWithBYOKLimiter falls back to DEFAULT_LIMITER_QUEUE_TIMEOUT_MS (0 = infinite).
     *  Conversation callers set 60_000 via runConversationLoop; review callers leave undefined. */
    queueTimeoutMs?: number;
    fn: () => Promise<T>;
}): Promise<T> {
    const wrapped = async () => {
        try {
            return await params.fn();
        } catch (err) {
            reportByokError(err);
            throw err;
        }
    };
    return runWithBYOKLimiter(
        {
            byokConfig: params.byokConfig,
            organizationId: params.organizationId,
            role: params.role ?? 'main',
            abortSignal: params.abortSignal,
            queueTimeoutMs: params.queueTimeoutMs,
        },
        wrapped,
        params.label ?? 'generateText',
    );
}

export type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
export { buildLangfuseTelemetry } from '@libs/core/log/langfuse';

import {
    buildLangfuseTelemetry as _buildLangfuseTelemetry,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';
import { composeAbortSignal } from './parent-signal-compose';

/**
 * Build provider-specific reasoning `providerOptions` for a generateText call.
 * Telemetry metadata is no longer merged here — callers pass
 * `experimental_telemetry: buildLangfuseTelemetry(runName, meta)` separately.
 */
export function buildProviderOptions(
    runName: string,
    _meta?: LangfuseTelemetryMetadata,
    input?: {
        reasoningEffort?: ReasoningEffort;
        reasoningConfigOverride?: string;
        byokProvider?: BYOKProvider | string;
        modelName?: string;
        openrouterProviderOrder?: string[];
        openrouterAllowFallbacks?: boolean;
    },
): Record<string, any> {
    // JSON override takes precedence over effort preset
    if (input?.reasoningConfigOverride) {
        try {
            const parsed = JSON.parse(input.reasoningConfigOverride);
            const override = autoWrapProviderOverride(
                parsed,
                input?.byokProvider,
            );
            return {
                ...buildOpenRouterRouting(input),
                ...override,
            };
        } catch {
            // Invalid JSON — fall through to effort-based mapping
        }
    }

    const reasoning = buildReasoningProviderOptions(
        input?.byokProvider,
        input?.reasoningEffort,
        input?.modelName,
    );
    const routing = buildOpenRouterRouting(input);
    const merged = mergeOpenRouterOptions(reasoning, routing);
    logger.log({
        message: '[thinking] providerOptions resolved',
        context: 'buildProviderOptions',
        metadata: {
            runName,
            provider: input?.byokProvider,
            modelName: input?.modelName,
            reasoningEffort: input?.reasoningEffort,
            hasOverride: !!input?.reasoningConfigOverride,
            reasoningPayload: reasoning,
            openrouterRouting: routing,
        },
    });
    return merged;
}

/**
 * Build the OpenRouter provider-pinning payload, if configured.
 * Emits { openrouter: { provider: { order, allow_fallbacks } } } so the
 * upstream @openrouter/ai-sdk-provider forwards it in the request body.
 * Returns {} when no pinning is set or provider isn't OpenRouter.
 */
function buildOpenRouterRouting(input?: {
    byokProvider?: BYOKProvider | string;
    openrouterProviderOrder?: string[];
    openrouterAllowFallbacks?: boolean;
}): Record<string, any> {
    if (!input || input.byokProvider !== BYOKProvider.OPEN_ROUTER) return {};

    const order = input.openrouterProviderOrder?.filter(
        (p) => typeof p === 'string' && p.trim().length > 0,
    );
    const hasOrder = !!order && order.length > 0;
    const hasFallbacksOverride =
        typeof input.openrouterAllowFallbacks === 'boolean';

    if (!hasOrder && !hasFallbacksOverride) return {};

    const providerPayload: Record<string, any> = {};
    if (hasOrder) providerPayload.order = order;
    if (hasFallbacksOverride) {
        providerPayload.allow_fallbacks = input.openrouterAllowFallbacks;
    }
    return { openrouter: { provider: providerPayload } };
}

/**
 * Maps a BYOK provider ID to the Vercel AI SDK `providerOptions` namespace key
 * that the corresponding adapter listens on.
 */
const PROVIDER_OPTIONS_NAMESPACE: Partial<Record<string, string>> = {
    [BYOKProvider.ANTHROPIC]: 'anthropic',
    [BYOKProvider.ANTHROPIC_COMPATIBLE]: 'anthropic',
    [BYOKProvider.GOOGLE_GEMINI]: 'google',
    [BYOKProvider.GOOGLE_VERTEX]: 'google',
    [BYOKProvider.OPENAI]: 'openai',
    [BYOKProvider.OPEN_ROUTER]: 'openrouter',
    [BYOKProvider.OPENAI_COMPATIBLE]: 'openaiCompatible',
    [BYOKProvider.NOVITA]: 'openaiCompatible',
};

/** Keys that count as "already namespaced" at the top level of an override. */
const KNOWN_NAMESPACE_KEYS = new Set([
    'anthropic',
    'google',
    'openai',
    'openrouter',
    'openaiCompatible',
    'langsmith',
]);

/**
 * Auto-wrap a user-pasted override JSON under the active provider's namespace
 * when the user didn't wrap it themselves. Lets them paste flat shapes like
 *   { "thinking": { "type": "enabled" } }
 * for openai_compatible providers without knowing the Vercel SDK namespace rule.
 * If the override already contains a known namespace key, pass it through
 * unchanged so power users can multi-namespace explicitly.
 */
function autoWrapProviderOverride(
    override: unknown,
    provider?: BYOKProvider | string,
): Record<string, any> {
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
        return {};
    }
    const obj = override as Record<string, any>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return {};

    const alreadyNamespaced = keys.some((k) => KNOWN_NAMESPACE_KEYS.has(k));
    if (alreadyNamespaced) return obj;

    const ns = provider
        ? PROVIDER_OPTIONS_NAMESPACE[provider as string]
        : undefined;
    if (!ns) return obj; // Unknown provider — pass through and let the SDK decide.

    return { [ns]: obj };
}

/** Deep-merge the openrouter namespace so reasoning + routing co-exist. */
function mergeOpenRouterOptions(
    base: Record<string, any>,
    routing: Record<string, any>,
): Record<string, any> {
    if (!routing.openrouter) return base;
    const merged = { ...base };
    merged.openrouter = {
        ...(base.openrouter ?? {}),
        ...routing.openrouter,
    };
    return merged;
}
import { z } from 'zod';
import { BYOKProvider } from '@kodus/kodus-common/llm';
import { createLogger } from '@kodus/flow';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/**
 * Wrap a system prompt string with Anthropic cache_control when the model
 * is Claude-based. Returns the string unchanged for other providers.
 */
function withAnthropicCacheControl(
    systemPrompt: string,
    model: any,
):
    | string
    | {
          role: 'system';
          content: string;
          providerOptions: Record<string, any>;
      } {
    const modelId: string = model?.modelId ?? '';
    if (/claude|anthropic/i.test(modelId)) {
        return {
            role: 'system' as const,
            content: systemPrompt,
            providerOptions: {
                anthropic: { cacheControl: { type: 'ephemeral' } },
            },
        };
    }
    return systemPrompt;
}

export const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 5_000,
    medium: 15_000,
    high: 40_000,
};

/**
 * Build provider-specific reasoning/thinking options for generateText.
 *
 * Maps a normalized effort level to each provider's native format:
 *   - Anthropic (new): adaptive thinking + output_config.effort
 *   - Anthropic (old): enabled + budget_tokens
 *   - Google Gemini 3+: thinkingConfig.thinkingLevel (minimal/low/medium/high)
 *   - Google Gemini 2.5: thinkingConfig.thinkingBudget
 *   - OpenAI o-series: reasoningEffort (low/medium/high)
 *   - OpenRouter: reasoning.effort (normalized across providers)
 *   - Kimi/GLM/others via OPENAI_COMPATIBLE: thinking.type enabled/disabled
 *
 * Defaults when nothing configured: thinking stays OFF for all providers.
 *
 * Sources:
 *   Claude: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 *   Gemini: https://ai.google.dev/gemini-api/docs/thinking
 *   OpenRouter: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
export function buildReasoningProviderOptions(
    provider?: BYOKProvider | string,
    effort?: ReasoningEffort,
    modelName?: string,
): Record<string, any> {
    if (!effort || effort === 'none' || !provider) return {};

    switch (provider) {
        case BYOKProvider.ANTHROPIC: {
            // Models that support adaptive thinking (type: "adaptive" + effort):
            //   - Opus 4.6+, Opus 4.7+, Sonnet 4.6+, Sonnet 4.7+, mythos
            // Models that use enabled thinking (type: "enabled" + budget_tokens):
            //   - Sonnet 4.5, Sonnet 4.0, Opus 4.0, Sonnet 3.7
            const isAdaptiveCapable =
                modelName &&
                (/claude-(opus|sonnet)-4-[6-9]/i.test(modelName) ||
                    /claude-(opus|sonnet)-4-\d{2,}/i.test(modelName) ||
                    modelName.includes('mythos'));

            if (isAdaptiveCapable) {
                return {
                    anthropic: {
                        thinking: { type: 'adaptive' },
                        effort,
                    },
                };
            }

            return {
                anthropic: {
                    thinking: {
                        type: 'enabled',
                        budgetTokens: EFFORT_TO_BUDGET[effort],
                    },
                },
            };
        }

        case BYOKProvider.GOOGLE_GEMINI:
        case BYOKProvider.GOOGLE_VERTEX: {
            // Gemini 3+: thinkingLevel (minimal/low/medium/high)
            // Gemini 2.5: thinkingBudget (number)
            // Cannot disable thinking on Gemini 3.1 Pro.
            const isGemini3 =
                modelName &&
                (modelName.includes('gemini-3') ||
                    modelName.includes('gemini3'));

            if (isGemini3) {
                return {
                    google: {
                        thinkingConfig: { thinkingLevel: effort },
                    },
                };
            }

            return {
                google: {
                    thinkingConfig: {
                        thinkingBudget: EFFORT_TO_BUDGET[effort],
                    },
                },
            };
        }

        case BYOKProvider.OPENAI:
            // o-series and GPT-5: reasoningEffort (low/medium/high)
            return {
                openai: { reasoningEffort: effort },
            };

        case BYOKProvider.OPEN_ROUTER:
            // OpenRouter normalizes across all providers
            return {
                openrouter: { reasoning: { effort } },
            };

        case BYOKProvider.OPENAI_COMPATIBLE: {
            // Kimi K2.5: thinking ON by default, only need to send disable
            // GLM-5/5.1: thinking.type = enabled/disabled
            // For compatible providers that support thinking, send the
            // standard OpenAI-compatible thinking param
            return {
                openaiCompatible: {
                    thinking: { type: 'enabled' },
                },
            };
        }

        case BYOKProvider.ANTHROPIC_COMPATIBLE:
            // Anthropic-protocol endpoints from other vendors (Kimi Code,
            // Z.ai, DeepSeek). They speak the classic thinking shape
            // (enabled + budget_tokens); none of them implement Anthropic's
            // newer adaptive thinking, so always use the budget form.
            return {
                anthropic: {
                    thinking: {
                        type: 'enabled',
                        budgetTokens: EFFORT_TO_BUDGET[effort],
                    },
                },
            };

        default:
            return {};
    }
}
import { EnhancedJSONParser } from '@kodus/flow';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    getInternalModel,
    runWithBYOKLimiter,
    withStructuredOutputFallback,
    NoStructuredFallbackModelError,
    type BYOKLimiterRole,
} from './byok-to-vercel';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';
import {
    buildCoverageLedger,
    CoverageSummary,
    CoverageTier,
    getCoverageSummary,
    markCoverageFromToolCall,
    TIERED_TOTAL_COVERAGE_THRESHOLD,
} from './coverage-ledger';
import {
    compressMessages,
    estimateMessagesTokens,
    shouldCompress,
} from './context-compressor';

const logger = createLogger('AgentLoop');

/**
 * Normalize a Vercel AI SDK usage object into the cache-aware shape we
 * use internally. Handles both the current `inputTokenDetails` schema
 * (SDK v5+) and the deprecated `cachedInputTokens` scalar (older v4).
 * Missing fields default to 0 — we never return undefined, so accumulators
 * can sum safely.
 */
function extractUsage(usage: any): {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
} {
    if (!usage) {
        return {
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
        };
    }
    const details = usage.inputTokenDetails || {};
    const cacheRead = details.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
    const cacheWrite = details.cacheWriteTokens ?? 0;
    return {
        inputTokens: usage.inputTokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens:
            usage.outputTokenDetails?.reasoningTokens ??
            usage.reasoningTokens ??
            0,
    };
}

const MAX_STEPS_NORMAL = 20;
const MAX_STEPS_DEEP = 100;

/**
 * Step-budget pressure appended to the system prompt at specific bands,
 * to keep the agent from burning the whole maxSteps without synthesizing.
 *
 * Bands (relative to forceTextAfter = maxSteps - 2):
 *   - `urgent`    : last 3 steps before force-text — "synthesize now"
 *   - `encourage` : 4 steps before urgent — "form hypotheses, avoid new reads"
 *   - `free`      : anything earlier — no injected pressure
 *
 * Tiny budgets (maxSteps < 6) collapse the bands onto force-text, so we
 * skip injection entirely and let the existing force-text logic handle it.
 * That keeps the verifier (5 steps) and other narrow phases unharmed.
 */
function computeStepBudgetNote(
    stepNumber: number,
    maxSteps: number,
): { note: string; phase: 'free' | 'encourage' | 'urgent' } {
    const forceTextAfter = maxSteps - 2;
    if (maxSteps < 6 || stepNumber >= forceTextAfter) {
        return { note: '', phase: 'free' };
    }
    const urgentFrom = Math.max(forceTextAfter - 3, 3);
    const encourageFrom = Math.max(urgentFrom - 4, 2);
    if (stepNumber >= urgentFrom) {
        return {
            note: `\n\nSTEP BUDGET: you are on step ${stepNumber}/${maxSteps}. Final steps before the submit is forced. Synthesize findings from the evidence already collected. Do NOT start new exploration threads unless verifying a specific named hypothesis.`,
            phase: 'urgent',
        };
    }
    if (stepNumber >= encourageFrom) {
        return {
            note: `\n\nSTEP BUDGET: you are on step ${stepNumber}/${maxSteps}. Start forming concrete hypotheses from the evidence collected so far. Avoid new reads unless they answer a specific question you can state upfront.`,
            phase: 'encourage',
        };
    }
    return { note: '', phase: 'free' };
}
/**
 * Rough char-per-token ratio used by the preflight estimator. Matches
 * the same constant used by the base agent provider's prompt sizing.
 */
const PREFLIGHT_CHARS_PER_TOKEN = 4;
/**
 * Fraction of the context window held back for the model's reasoning
 * + tool-call output. The agent emits structured findings JSON and may
 * also produce thinking tokens; ~15% gives both room without being
 * wasteful. Clamped to at least 2_048 tokens because below that, even
 * a small `submitResult` payload can't fit.
 */
const PREFLIGHT_OUTPUT_RESERVE_RATIO = 0.15;
const PREFLIGHT_MIN_OUTPUT_RESERVE_TOKENS = 2_048;

/**
 * Defense-in-depth preflight: before the agent loop calls generateText,
 * estimate prompt tokens and refuse to proceed if they exceed the
 * configured model's context window. Without this check, the Vercel AI
 * SDK would retry the call up to `maxRetries` times against a 12K-context
 * Llama with a 71K prompt — burning the AGENT_TIMEOUT_MS budget while
 * each attempt fails identically.
 *
 * Pure function (no awaits, no I/O). Exported so it can be unit-tested.
 * When contextWindowTokens is undefined we cannot enforce — callers that
 * already resolve it (BaseCodeReviewAgentProvider does) will always pass
 * a number.
 */
export function assertPromptFitsInContext(params: {
    systemPrompt: string;
    userPrompt: string;
    contextWindowTokens: number | undefined;
    modelName: string;
}): void {
    if (!params.contextWindowTokens || params.contextWindowTokens <= 0) {
        return;
    }
    const promptChars =
        (params.systemPrompt?.length ?? 0) + (params.userPrompt?.length ?? 0);
    const estimatedTokens = Math.ceil(promptChars / PREFLIGHT_CHARS_PER_TOKEN);
    const outputReserve = Math.max(
        PREFLIGHT_MIN_OUTPUT_RESERVE_TOKENS,
        Math.floor(params.contextWindowTokens * PREFLIGHT_OUTPUT_RESERVE_RATIO),
    );
    if (estimatedTokens + outputReserve > params.contextWindowTokens) {
        throw new AgentPromptTooLargeError({
            estimatedTokens,
            contextWindowTokens: params.contextWindowTokens,
            modelName: params.modelName,
        });
    }
}

export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max per agent
// 10 minutes per individual LLM call — matches the undici headersTimeout
// set in the worker bootstrap so neither layer aborts the other. Large
// Gemini calls (>500K prompt + high reasoning) can legitimately take
// 4-7 minutes of wall-clock before the first byte arrives.
export const LLM_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Create an AbortSignal that fires after the given ms. */
export function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

/**
 * Hard timeout wrapper — kills the promise even if the provider ignores AbortSignal.
 * Uses Promise.race so that a stuck HTTP connection can never block the pipeline forever.
 *
 * Every generateText call already passes timeoutSignal(ms) as AbortSignal,
 * but some providers (OpenAI-compatible proxies like Synthetic, Z.AI) ignore it.
 * This is the safety net.
 */
export function hardTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `[HARD-TIMEOUT] ${label} exceeded ${ms / 1000}s`,
                        ),
                    ),
                ms + 5_000, // +5s grace so AbortSignal fires first when it works
            );
        }),
    ]).finally(() => clearTimeout(timer));
}

/** Schema for structured output */
const suggestionSchema = z.object({
    relevantFile: z.string(),
    language: z.string().optional(),
    label: z.enum(['bug', 'security', 'performance']).optional(),
    suggestionContent: z.string(),
    existingCode: z.string(),
    improvedCode: z.string(),
    oneSentenceSummary: z.string().optional(),
    relevantLinesStart: z.number().optional(),
    relevantLinesEnd: z.number().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), // V2 compat
    confidence: z.number().min(1).max(10).optional(), // 1-10: how confident the agent is in this finding
    ruleUuid: z.string().optional(), // Kody Rules: UUID of the violated rule
});

const _findingsSchema = z.object({
    reasoning: z.string(),
    suggestions: z.array(suggestionSchema),
});

export type FindingsOutput = z.infer<typeof _findingsSchema>;

const _verificationSchema = z.object({
    index: z.number(),
    keep: z.boolean(),
    rationale: z.string(),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
});

// ─── Done-tool infrastructure ───────────────────────────────────────────────
// A "done tool" is a tool WITHOUT an `execute` function.  When the model
// calls it the AI SDK stops the loop immediately and the structured args
// are available in `result.toolCalls`.  This replaces fragile free-text
// JSON parsing with schema-validated output.

const DONE_TOOL_NAME = 'submitResult' as const;

/**
 * Create a done-tool with a given Zod schema.
 * The tool has no `execute`, so calling it stops the agent loop.
 *
 * `strict` controls provider-specific schema enforcement:
 * - Gemini: `true` activates VALIDATED mode, which prevents empty-args calls
 *   (the known bug where Gemini "calls" submitResult with `{}`).
 * - OpenAI (and compatible: Moonshot, z.AI, Novita, OpenRouter when routing
 *   to OpenAI-style models): `true` activates Structured Outputs, which
 *   requires every schema property to be listed in `required`. Our findings
 *   schema has optional props, so strict mode makes the provider reject the
 *   tool up front with "Invalid schema for function 'submitResult'".
 * - Anthropic: tool_use API doesn't enforce strict schemas; the flag is
 *   effectively ignored either way.
 *
 * Callers should pass `strict: true` only when the target model is Gemini.
 */
function createDoneTool<T extends z.ZodType>(
    description: string,
    schema: T,
    strict: boolean,
) {
    return defineTool({
        description,
        // AI SDK v6 uses `inputSchema`, not `parameters` (which is silently
        // ignored — that's why Gemini was calling the tool with empty args).
        inputSchema: schema as any,
        strict,
        // no execute → stops the loop
    });
}

const FINDINGS_TOOL_DESCRIPTION =
    'Submit your final code review findings. Call this tool when your investigation is complete.';
const VERIFICATION_TOOL_DESCRIPTION =
    'Submit your verification verdict for the candidate finding. Call this tool when you have enough evidence.';

/**
 * Return true when the given Vercel AI SDK model is a Gemini model, so that
 * callers can enable strict/VALIDATED mode for the done-tool schema.
 * Detection uses the model id (e.g. "gemini-3.1-pro-preview-customtools")
 * rather than the provider name, so Gemini served via OpenRouter or other
 * proxies is still recognized.
 */
function isGeminiModel(model: unknown): boolean {
    const modelId = (model as any)?.modelId;
    return typeof modelId === 'string' && /^gemini[-_]/i.test(modelId);
}

/**
 * Pre-build the done-tools for a given model. Cheap to call; the returned
 * object is a plain `{ findings, verification }` whose `strict` matches the
 * provider's expectations.
 */
function buildDoneTools(model: unknown) {
    const strict = isGeminiModel(model);
    return {
        findings: createDoneTool(
            FINDINGS_TOOL_DESCRIPTION,
            _findingsSchema,
            strict,
        ),
        verification: createDoneTool(
            VERIFICATION_TOOL_DESCRIPTION,
            _verificationSchema,
            strict,
        ),
    };
}

/**
 * Extract the done-tool result from a generateText result.
 * Returns the parsed args if the model called the done tool, or null.
 */
function extractDoneToolResult<T>(result: any): T | null {
    const extract = (tc: any): T | null => {
        let args = tc?.args ?? tc?.input ?? null;
        // Safety net: Gemini sometimes calls the tool with empty args {}
        // even in VALIDATED mode when the schema is very complex.
        if (
            !args ||
            (typeof args === 'object' && Object.keys(args).length === 0)
        ) {
            logger.warn({
                message:
                    '[DONE-TOOL] Model called submitResult with empty args — falling back to text parsing',
                context: 'AgentLoop',
            });
            return null;
        }
        // Gemini (customtools mode) occasionally double-encodes the structured
        // args as `{ result: "<stringified JSON>" }` instead of emitting the
        // schema fields directly. Detect that single-key wrapper and unwrap
        // it so downstream code sees the expected shape. Observed crashing
        // with `TypeError: Cannot read properties of undefined (reading
        // 'length')` on the [AGENT-DONE-TOOL] log line.
        if (
            typeof args === 'object' &&
            (args as any).result !== undefined &&
            typeof (args as any).result === 'string' &&
            Object.keys(args as any).length === 1
        ) {
            try {
                const parsed = JSON.parse((args as any).result);
                if (parsed && typeof parsed === 'object') {
                    logger.warn({
                        message:
                            '[DONE-TOOL] Unwrapped double-encoded args from Gemini (single-key `result` string wrapper)',
                        context: 'AgentLoop',
                    });
                    args = parsed;
                }
            } catch {
                logger.warn({
                    message:
                        '[DONE-TOOL] Model returned `{ result: <string> }` but inner payload is not valid JSON — falling back to text parsing',
                    context: 'AgentLoop',
                });
                return null;
            }
        }
        return args as T;
    };

    // Check result.toolCalls (last step) first
    const calls: any[] = result?.toolCalls || [];
    const doneCall = calls.find((tc: any) => tc.toolName === DONE_TOOL_NAME);
    if (doneCall) {
        return extract(doneCall);
    }

    // Check all steps in case it was called in an earlier step
    const steps: any[] = result?.steps || [];
    for (let i = steps.length - 1; i >= 0; i--) {
        const stepCalls: any[] = steps[i]?.toolCalls || [];
        const call = stepCalls.find(
            (tc: any) => tc.toolName === DONE_TOOL_NAME,
        );
        if (call) {
            return extract(call);
        }
    }

    return null;
}

/**
 * Validate and sanitize a done-tool result against the FindingsOutput schema.
 * Returns null if the result is null or fails validation, ensuring downstream
 * code never receives a FindingsOutput with missing `suggestions`.
 */
export function sanitizeFindingsResult(
    raw: FindingsOutput | null,
): FindingsOutput | null {
    if (!raw) return null;
    const parsed = _findingsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    logger.warn({
        message:
            '[DONE-TOOL] FindingsOutput failed Zod validation, falling back to text parsing',
        context: 'AgentLoop',
        metadata: {
            zodErrors: parsed.error.issues.map(
                (i) => `${i.path.join('.')}: ${i.message}`,
            ),
            rawKeys: Object.keys(raw),
            hasSuggestions: Array.isArray((raw as any).suggestions),
        },
    });
    // Attempt partial recovery: if suggestions is an array, keep it;
    // otherwise fall back to text parsing (return null).
    if (Array.isArray((raw as any).suggestions)) {
        return {
            reasoning: (raw as any).reasoning ?? '',
            suggestions: (raw as any).suggestions,
        };
    }
    return null;
}

export interface AgentLoopInput {
    model: LanguageModel;
    systemPrompt: string;
    userPrompt: string;
    agentName?: string; // e.g. 'kodus-bug-review-agent' — used as Langfuse observation name
    telemetryMetadata?: LangfuseTelemetryMetadata;
    maxSteps?: number;
    onStepFinish?: (event: any) => void;
    changedFiles?: any[];
    prNumber?: number;
    repositoryFullName?: string;
    /** Base branch of the PR (e.g. "main"). Used by git diff tools. */
    baseBranch?: string;
    /** Pre-computed call graph shared by reviewers and verifier. */
    callGraph?: string;
    /** Map of normalized filename to tier ('critical' | 'warm' | 'optional').
     *  When present, the coverage ledger runs in tiered mode: critical
     *  files must be covered; warm/optional count toward the 70% total
     *  floor. When absent, coverage stays flat (legacy 100%-all-files). */
    fileTiers?: Map<string, CoverageTier>;
    /** Review mode: 'fast' skips heavy passes and caps steps; 'normal' skips verify only for very-high-confidence findings; 'deep' verifies everything. */
    reviewMode?: 'fast' | 'normal' | 'deep';
    /** Model context window in tokens. Used to trigger context compression when the message history grows too large. */
    contextWindowTokens?: number;
    /** When true, skip recovery/rescue/second-chance passes. Used by rule-checking agents that don't benefit from open-ended exploration. */
    skipHeavyPasses?: boolean;
    /** When true, skip ONLY the synthesis-rescue pass while still running
     *  coverage-recovery and coverage-second-chance. Useful for agents
     *  that benefit from re-investigating uncovered files but don't need
     *  the open-ended "rethink the review" pass — typically rule-checking
     *  agents where rules are explicit and synthesis just re-words the
     *  same findings, leading to dedup churn and duplicate comments. */
    skipSynthesisRescue?: boolean;
    /** Reasoning effort level from BYOK config. Mapped to provider-specific
     *  providerOptions (anthropic.thinking, google.thinkingConfig, etc). */
    reasoningEffort?: ReasoningEffort;
    /** Raw JSON override for reasoning config — takes precedence over effort preset. */
    reasoningConfigOverride?: string;
    /** BYOK provider type — needed to map reasoning effort to the correct
     *  provider-specific format in providerOptions. */
    byokProvider?: BYOKProvider | string;
    /** Pin OpenRouter requests to specific upstream providers (in order).
     *  Ignored when byokProvider !== 'openrouter'. */
    openrouterProviderOrder?: string[];
    /** Allow OpenRouter to fall back to other upstreams when the preferred
     *  order is unavailable. Defaults to OpenRouter's default (true) when
     *  undefined; set to false to hard-fail if the pinned providers aren't
     *  available. */
    openrouterAllowFallbacks?: boolean;
    /** Parent (job-level) AbortSignal. When it aborts, the local
     *  AGENT_TIMEOUT_MS controller is aborted too, propagating cancellation
     *  to the underlying generateText call (which respects abortSignal). */
    parentSignal?: AbortSignal;
}

/**
 * Secrets and service references that must NEVER be serialized into
 * tracing spans or LLM payloads. Extracted from the old AgentLoopInput
 * to prevent accidental leaks (NestJS ConfigService carries all env vars).
 */
export interface AgentLoopSecrets {
    /**
     * Remote commands for the E2B sandbox. When undefined, the agent runs
     * in self-contained mode (no tools, single-shot analysis on the diffs
     * inlined in the user prompt). Used by the CLI trial flow where there
     * is no sandbox available.
     */
    remoteCommands: RemoteCommands | undefined;
    byokConfig?: BYOKConfig;
    gitHubToken?: string;
    /**
     * External documentation search adapter (Exa-backed). When provided,
     * registers the `searchDocs` tool on the agent so it can verify
     * framework/library behavior against official docs. Required for the
     * verifier to validate findings about third-party APIs.
     */
    documentationSearchService?: DocumentationSearchAdapter;
    /** Options forwarded to the documentation search adapter on each call. */
    documentationSearchOptions?: Record<string, unknown>;
    /**
     * Queue timeout passed to runWithBYOKLimiter for all LLM calls in this loop.
     * When undefined, falls back to DEFAULT_LIMITER_QUEUE_TIMEOUT_MS (0 = infinite).
     * Conversation callers set this to 60_000 to fail fast if review holds the slot.
     * MAINT-02: This is a generic field — not conversation-specific; review callers
     * can also set it if they need bounded queue behavior.
     */
    byokQueueTimeoutMs?: number;
    /**
     * Optional sink for BYOK LLM failures. Called once per failed
     * `generateText` call inside the loop; safe to omit. Used to drive
     * the `byok.llm_errors_threshold` notification — caller wires it to
     * `ByokErrorCounter.record`.
     */
    byokErrorReporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
}

export interface AgentLoopOutput {
    findings: FindingsOutput;
    text: string;
    steps: number;
    toolCalls: Array<{
        tool: string;
        toolName?: string;
        args: Record<string, unknown>;
        result?: string;
    }>;
    finishReason: string;
    /** Whether findings came from direct JSON parse or fallback generateObject */
    source: 'json-parse' | 'generate-object' | 'empty';
    usage: {
        /** Total input tokens sent to the model (includes cached). */
        inputTokens: number;
        /** Portion of input tokens served from provider cache (Gemini/OpenAI/
         *  Moonshot/DeepSeek implicit cache, Anthropic ephemeral reads). */
        cacheReadTokens: number;
        /** Portion of input tokens written to cache on this request (pays
         *  Anthropic's write premium; 0 for implicit-cache providers). */
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
    /** Suggestions discarded by severity filter (before verify). */
    discardedBySeverity?: FindingsOutput['suggestions'];
    /** Suggestions discarded by the verifier. */
    droppedByVerify?: FindingsOutput['suggestions'];
    /** Token usage for the verification sub-step only (included in total usage). */
    verificationUsage?: {
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
    };
    coverage: CoverageSummary;
    verification?: VerificationTraceSummary | null;
    anomalies: AgentAnomalySummary;
    /** Fidelity warnings emitted during the loop (small context window
     *  forced compact prompt, dropped callGraph, etc). Always present;
     *  empty array when no adaptive strategy fired. */
    warnings: ReviewWarning[];
}

interface SuggestionVerificationDecision {
    index: number;
    keep: boolean;
    rationale: string;
    confidence?: 'high' | 'medium' | 'low';
}

interface ToolEvidenceSummary {
    strongFiles: string[];
    weakFiles: string[];
}

interface VerificationDecisionTrace {
    index: number;
    relevantFile: string;
    action: 'keep' | 'drop' | 'refine';
    parseMode: 'direct' | 'fallback-llm' | 'default-keep';
    rationale: string;
    confidence?: 'high' | 'medium' | 'low';
    verifierEvidence: ToolEvidenceSummary;
    rawTextPreview?: string;
}

interface SuggestionEvidenceBundle {
    bundle: string;
    relevantInvestigationLog: string;
    relevantInvestigationCount: number;
    callGraphHint: string;
}

export interface VerificationTraceSummary {
    beforeCount: number;
    afterCount: number;
    droppedByVerifier: number;
    /** @deprecated Always 0 — evidence gate now forces verification instead of dropping. Kept for backwards compatibility. */
    droppedByEvidenceFilter: number;
    sentToEvidenceGate?: number;
    decisions: VerificationDecisionTrace[];
}

export interface AgentAnomalySummary {
    stepsLe2: boolean;
    zeroToolCalls: boolean;
    zeroStrongEvidenceFiles: boolean;
    zeroCoverage: boolean;
    lowCoverage: boolean;
    lowStrongEvidenceFiles: boolean;
}

/**
 * Run the agent loop with native function calling.
 *
 * `secrets` is kept separate from `input` so that span I/O recording
 * (Langfuse / OTel) never captures API keys, tokens, or NestJS service
 * instances that carry ConfigService with all env vars.
 */
export async function runAgentLoop(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
): Promise<AgentLoopOutput> {
    // Establish the BYOK error reporting context once at the top of the
    // loop; all nested throttledGenerateText calls inherit it via ALS.
    return byokErrorContext.run(
        {
            reporter: secrets.byokErrorReporter,
            organizationId: input.telemetryMetadata?.organizationId,
            provider:
                typeof input.byokProvider === 'string'
                    ? input.byokProvider
                    : undefined,
        },
        () => runAgentLoopBody(input, secrets),
    );
}

async function runAgentLoopBody(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
): Promise<AgentLoopOutput> {
    const tools = buildAgentTools(
        secrets.remoteCommands,
        secrets.gitHubToken,
        input.repositoryFullName,
        secrets.documentationSearchService,
        secrets.documentationSearchOptions,
        input.callGraph, // getCallers tool backed by the runtime call graph
    );
    // Self-contained mode: no sandbox, no tools. The agent analyzes diffs
    // and any inlined fileContent in a single LLM call. Used by CLI trial.
    const isSelfContained = Object.keys(tools).length === 0;
    const coverageTargets = buildCoverageLedger(input.changedFiles, {
        fileTiers: input.fileTiers,
    });

    // Cache-friendly step budget injection: Gemini implicit prompt caching
    // is prefix-based — any change to the `system` field invalidates the
    // whole prefix for the next call. We track whether the encourage/urgent
    // transition notes have been appended as trailing user messages so we
    // only break the cache once per band transition, not every step.
    let encourageNoteAppended = false;
    let urgentNoteAppended = false;

    const allToolCalls: AgentLoopOutput['toolCalls'] = [];
    let stepCount = 0;
    let lastStepText = ''; // Capture text from intermediate steps for timeout recovery
    const allStepTexts: string[] = []; // Accumulate ALL text steps for better timeout recovery
    let totalInputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let verificationTrace: VerificationTraceSummary | null = null;

    // Timeout: 8 minutes max per agent — some models need many tool calls
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
        logger.warn({
            message: `[AGENT-TIMEOUT] Agent exceeded ${AGENT_TIMEOUT_MS / 1000}s timeout, aborting`,
            context: 'AgentLoop',
        });
        abortController.abort();
    }, AGENT_TIMEOUT_MS);

    // Compose job-level (parentSignal) into the local controller. When the
    // outer router timeout (1h45min for code_review) fires, we abort the
    // agent's generateText too instead of leaving an LLM call running ghost
    // in the background.
    const detachParentSignal = composeAbortSignal(
        input.parentSignal,
        abortController,
        () =>
            logger.warn({
                message:
                    '[AGENT-TIMEOUT] Parent (job) signal aborted, cancelling agent',
                context: 'AgentLoop',
            }),
    );

    // Defense-in-depth: if the assembled prompt cannot fit, fail before
    // the SDK retries the same doomed call up to maxRetries times.
    // BaseCodeReviewAgentProvider has its own (coarser) overhead-only
    // preflight; this one accounts for the actual systemPrompt +
    // userPrompt size and catches cases where the overhead check passed
    // but the diff content still pushes the total over the window.
    assertPromptFitsInContext({
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        contextWindowTokens: input.contextWindowTokens,
        modelName: (input.model as any)?.modelId ?? input.agentName ?? 'unknown',
    });

    let result;
    try {
        result = await throttledGenerateText({
            byokConfig: secrets.byokConfig,
            organizationId: input.telemetryMetadata?.organizationId,
            role: 'main',
            label: input.agentName ?? 'agent-loop',
            abortSignal: abortController.signal,
            queueTimeoutMs: secrets.byokQueueTimeoutMs,
            fn: () =>
                generateText({
                    ...({ __kodusHardTimeoutMs: AGENT_TIMEOUT_MS } as any),
                    model: input.model,
                    // Cap SDK-level retries to 1 on the main loop. The default
                    // is 2 (3 total attempts); when the model genuinely can't
                    // serve the prompt (context overflow, hard auth fail) the
                    // extra retry burns minutes of the AGENT_TIMEOUT_MS budget
                    // with no chance of succeeding. Cheap sub-calls
                    // (severity classifier, dedup) keep the default since
                    // their retries are short and cover real transient blips.
                    maxRetries: 1,
                    abortSignal: abortController.signal,
                    system: withAnthropicCacheControl(
                        input.systemPrompt,
                        input.model,
                    ) as any,
                    prompt: input.userPrompt,
                    experimental_telemetry: _buildLangfuseTelemetry(
                        input.agentName ?? 'agent-loop',
                        input.telemetryMetadata,
                    ),
                    providerOptions: buildProviderOptions(
                        input.agentName ?? 'agent-loop',
                        input.telemetryMetadata,
                        {
                            reasoningEffort: input.reasoningEffort,
                            reasoningConfigOverride:
                                input.reasoningConfigOverride,
                            byokProvider: input.byokProvider,
                            modelName: (input.model as any)?.modelId,
                            openrouterProviderOrder:
                                input.openrouterProviderOrder,
                            openrouterAllowFallbacks:
                                input.openrouterAllowFallbacks,
                        },
                    ),
                    tools: isSelfContained
                        ? tools
                        : {
                              ...tools,
                              [DONE_TOOL_NAME]: buildDoneTools(input.model)
                                  .findings,
                          },
                    // Self-contained mode has no tools — a single LLM call
                    // is enough to produce the final JSON response.
                    stopWhen: isSelfContained
                        ? stepCountIs(1)
                        : [
                              hasToolCall(DONE_TOOL_NAME),
                              stepCountIs(
                                  input.maxSteps ||
                                      (input.reviewMode === 'deep'
                                          ? MAX_STEPS_DEEP
                                          : MAX_STEPS_NORMAL),
                              ),
                          ],
                    // Last 2 steps: force the model to call submitResult.
                    prepareStep: ({ stepNumber, messages }: any) => {
                        // Self-contained mode has no tools and a single
                        // step, so coverage debt / force-text logic does
                        // not apply. Just return empty modifications.
                        if (isSelfContained) {
                            return {};
                        }

                        const maxSteps =
                            input.maxSteps ||
                            (input.reviewMode === 'deep'
                                ? MAX_STEPS_DEEP
                                : MAX_STEPS_NORMAL);
                        const forceTextAfter = maxSteps - 2;
                        const { note: stepBudgetNote, phase: stepBudgetPhase } =
                            computeStepBudgetNote(stepNumber, maxSteps);
                        if (stepBudgetPhase === 'urgent') {
                            logger.log({
                                message: `[AGENT-STEP-BUDGET] urgent step=${stepNumber}/${maxSteps}`,
                                context: 'AgentLoop',
                            });
                        }
                        // Depth-first: no coverage-debt nudge (we don't force breadth).
                        const coverageDebt = '';

                        // Context compression: if the message history is
                        // approaching the model's context window, truncate
                        // older tool-result content (aggressively) while
                        // preserving the head (system + user with <Diffs>)
                        // and the most recent tool exchanges. Injects a
                        // recap system message built from allToolCalls —
                        // our own tracking array, preserved intact so
                        // downstream passes keep full investigation history.
                        let compressedMessages: any[] | undefined;
                        if (
                            input.contextWindowTokens &&
                            messages &&
                            messages.length > 0
                        ) {
                            const check = shouldCompress(
                                messages,
                                input.contextWindowTokens,
                            );
                            if (check.should) {
                                const attempt = compressMessages(
                                    messages,
                                    allToolCalls,
                                );
                                const afterTokens =
                                    estimateMessagesTokens(attempt);
                                const savedTokens =
                                    check.currentTokens - afterTokens;
                                // Only use the compressed version if it actually saved tokens
                                if (savedTokens > 0) {
                                    compressedMessages = attempt;
                                    logger.log({
                                        message: `[AGENT-COMPRESS] step=${stepNumber} ${check.currentTokens} → ${afterTokens} tokens (saved ${savedTokens}), ${messages.length} → ${attempt.length} messages`,
                                        context: 'AgentLoop',
                                        metadata: {
                                            stepNumber,
                                            beforeTokens: check.currentTokens,
                                            afterTokens,
                                            savedTokens,
                                            beforeMessages: messages.length,
                                            afterMessages: attempt.length,
                                            thresholdTokens:
                                                check.thresholdTokens,
                                            contextWindowTokens:
                                                input.contextWindowTokens,
                                        },
                                    });
                                }
                                // If nothing could be truncated, fall through silently — the
                                // threshold check will re-run on the next step anyway.
                            }
                        }

                        // Force-text: last 2 steps override system to
                        // demand JSON-only. Accept the single cache miss
                        // here — by this point we're on the final call or
                        // two and the saving isn't worth the carrying
                        // complexity.
                        if (stepNumber >= forceTextAfter) {
                            if (coverageDebt) {
                                logger.log({
                                    message: `[AGENT-COVERAGE-DEBT] step=${stepNumber}/${maxSteps} pending=${getCoverageSummary(coverageTargets).pendingTargets} — prioritizing uncovered changed files`,
                                    context: 'AgentLoop',
                                });
                            }
                            logger.log({
                                message: `[AGENT-FORCE-TEXT] step=${stepNumber}/${maxSteps} — removing tools, forcing JSON response`,
                                context: 'AgentLoop',
                            });
                            return {
                                ...(compressedMessages
                                    ? { messages: compressedMessages }
                                    : {}),
                                toolChoice: 'none' as const,
                                activeTools: [],
                                system:
                                    input.systemPrompt +
                                    '\n\nIMPORTANT: You have reached the final response step. ' +
                                    'Do NOT call any more tools. ' +
                                    'Respond ONLY with a JSON object containing your findings. ' +
                                    'If you found no issues, return an empty suggestions array.',
                            };
                        }

                        // Cache-friendly injection: instead of appending
                        // the step-budget note / coverage-debt snapshot to
                        // `system` (which invalidates the whole prefix),
                        // we append them as a trailing user message exactly
                        // at band transitions. Everything before the new
                        // message stays cacheable.
                        let appendedNote: string | null = null;
                        if (
                            stepBudgetPhase === 'urgent' &&
                            !urgentNoteAppended
                        ) {
                            appendedNote =
                                stepBudgetNote.trim() +
                                (coverageDebt
                                    ? `\n\n${coverageDebt}\nPrioritize the uncovered critical files before anything else.`
                                    : '');
                            urgentNoteAppended = true;
                        } else if (
                            stepBudgetPhase === 'encourage' &&
                            !encourageNoteAppended
                        ) {
                            appendedNote =
                                stepBudgetNote.trim() +
                                (coverageDebt
                                    ? `\n\n${coverageDebt}\nPrioritize the uncovered critical files before anything else.`
                                    : '');
                            encourageNoteAppended = true;
                        }

                        if (appendedNote) {
                            const baseMessages = compressedMessages || messages;
                            return {
                                messages: [
                                    ...baseMessages,
                                    {
                                        role: 'user' as const,
                                        content: appendedNote,
                                    },
                                ],
                            };
                        }

                        // Steady state: never touch `system`. Only return a
                        // compressed messages array if compression fired.
                        return compressedMessages
                            ? { messages: compressedMessages }
                            : {};
                    },
                    onStepFinish: (event: any) => {
                        stepCount++;

                        if (event.toolCalls) {
                            // Build a lookup of tool results — different providers use different structures
                            const resultLookup = new Map<string, string>();
                            const toolResults: any[] = event.toolResults || [];

                            for (const tr of toolResults) {
                                const id = tr?.toolCallId || tr?.id || '';
                                const val =
                                    tr?.result ??
                                    tr?.output ??
                                    tr?.content ??
                                    '';
                                if (id) resultLookup.set(id, String(val));
                            }

                            for (const tc of event.toolCalls) {
                                const args =
                                    (tc as any).args || (tc as any).input || {};

                                // Try multiple ID fields to match tool call → result
                                const callId =
                                    tc.toolCallId || (tc as any).id || '';
                                let resultStr = resultLookup.get(callId) || '';

                                // Fallback: if toolResults has same count as toolCalls, match by index
                                if (
                                    !resultStr &&
                                    toolResults.length ===
                                        event.toolCalls.length
                                ) {
                                    const idx = event.toolCalls.indexOf(tc);
                                    if (idx >= 0 && toolResults[idx]) {
                                        const tr = toolResults[idx];
                                        resultStr = String(
                                            tr?.result ??
                                                tr?.output ??
                                                tr?.content ??
                                                '',
                                        );
                                    }
                                }

                                allToolCalls.push({
                                    tool: tc.toolName,
                                    toolName: tc.toolName,
                                    args,
                                    result: resultStr.substring(0, 500),
                                });

                                const newlyTouched = markCoverageFromToolCall(
                                    coverageTargets,
                                    tc.toolName,
                                    args,
                                    stepCount,
                                );
                                if (newlyTouched.length > 0) {
                                    logger.log({
                                        message: `[AGENT-COVERAGE] step=${stepCount} touched ${newlyTouched.map((target) => target.file).join(', ')}`,
                                        context: 'AgentLoop',
                                        metadata: {
                                            step: stepCount,
                                            touchedFiles: newlyTouched.map(
                                                (target) => target.file,
                                            ),
                                            coverage:
                                                getCoverageSummary(
                                                    coverageTargets,
                                                ),
                                        },
                                    });
                                }

                                logger.log({
                                    message: `[AGENT-TOOL] step=${stepCount} ${tc.toolName}(${JSON.stringify(args).substring(0, 200)}) → ${resultStr ? resultStr.substring(0, 150) : '(empty)'}${resultStr.length > 150 ? '...' : ''}`,
                                    context: 'AgentLoop',
                                    metadata: {
                                        step: stepCount,
                                        tool: tc.toolName,
                                        args,
                                        resultLength: resultStr.length,
                                    },
                                });
                            }
                        }

                        if (event.text) {
                            lastStepText = event.text;
                            allStepTexts.push(event.text);
                            logger.log({
                                message: `[AGENT-TEXT] step=${stepCount} finishReason=${event.finishReason} textLength=${event.text.length} tokens=${event.usage?.totalTokens ?? 0}`,
                                context: 'AgentLoop',
                                metadata: {
                                    step: stepCount,
                                    finishReason: event.finishReason,
                                    textLength: event.text.length,
                                    textPreview: event.text.substring(0, 300),
                                    usage: event.usage,
                                },
                            });
                        }

                        // Track cumulative token usage for timeout recovery.
                        // Capture cache read/write breakdown so downstream
                        // reporting reflects what the customer is actually
                        // billed (cached tokens get 50-90% off depending on
                        // provider).
                        if (event.usage) {
                            const u = extractUsage(event.usage);
                            totalInputTokens += u.inputTokens;
                            totalCacheReadTokens += u.cacheReadTokens;
                            totalCacheWriteTokens += u.cacheWriteTokens;
                            totalOutputTokens += u.outputTokens;
                            totalReasoningTokens += u.reasoningTokens;
                        }

                        input.onStepFinish?.(event);
                    },
                }),
        });
    } catch (error) {
        clearTimeout(timeoutHandle);
        detachParentSignal();
        if (abortController.signal.aborted) {
            // Try to recover findings from the last text the model produced before timeout
            let findings: FindingsOutput | null = null;
            let source: AgentLoopOutput['source'] = 'empty';

            // Try to recover from ALL accumulated text steps (not just the last one)
            // Models often produce partial findings in intermediate steps before timeout
            const textsToTry = [
                lastStepText,
                ...allStepTexts.slice().reverse(), // Try most recent first
                allStepTexts.join('\n\n'), // Try concatenated as last resort
            ].filter((t) => t && t.length > 50);

            // Deduplicate
            const uniqueTexts = [...new Set(textsToTry)];

            for (const text of uniqueTexts) {
                if (findings && findings.suggestions.length > 0) break;

                // Strategy 1: Try to parse JSON directly (safe — no hallucination risk)
                findings = tryParseFindings(text);
                if (findings && findings.suggestions.length > 0) {
                    source = 'json-parse';
                    logger.log({
                        message: `[AGENT-TIMEOUT-RECOVERY] Recovered ${findings.suggestions.length} suggestions from step text (${text.length} chars)`,
                        context: 'AgentLoop',
                    });
                    break;
                }
            }

            // Strategy 2: If no JSON found, try fallback LLM with the richest text
            if (!findings) {
                const bestText = uniqueTexts.find(
                    (t) => t.length > 100 && looksLikeFindings(t),
                );
                if (bestText) {
                    try {
                        const fallbackResult = await structureWithFallbackModel(
                            bestText,
                            secrets.byokConfig,
                            input.telemetryMetadata?.organizationId,
                            secrets.byokQueueTimeoutMs,
                        );
                        if (
                            fallbackResult &&
                            fallbackResult.findings.suggestions.length > 0
                        ) {
                            findings = fallbackResult.findings;
                            totalInputTokens +=
                                fallbackResult.usage.inputTokens;
                            totalCacheReadTokens +=
                                fallbackResult.usage.cacheReadTokens;
                            totalCacheWriteTokens +=
                                fallbackResult.usage.cacheWriteTokens;
                            totalOutputTokens +=
                                fallbackResult.usage.outputTokens;
                            totalReasoningTokens +=
                                fallbackResult.usage.reasoningTokens;
                            source = 'generate-object';
                            logger.log({
                                message: `[AGENT-TIMEOUT-RECOVERY] Recovered ${findings.suggestions.length} suggestions via fallback model (${bestText.length} chars)`,
                                context: 'AgentLoop',
                            });
                        }
                    } catch {
                        // Best effort
                    }
                }
            }

            logger.warn({
                message: `[AGENT-TIMEOUT] Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s (${stepCount} steps, ${allToolCalls.length} tool calls, recovered=${findings?.suggestions?.length ?? 0})`,
                context: 'AgentLoop',
            });

            return {
                findings: findings || {
                    reasoning: 'Agent timed out',
                    suggestions: [],
                },
                text: lastStepText,
                steps: stepCount,
                toolCalls: allToolCalls,
                finishReason: 'timeout',
                source,
                usage: {
                    inputTokens: totalInputTokens,
                    cacheReadTokens: totalCacheReadTokens,
                    cacheWriteTokens: totalCacheWriteTokens,
                    outputTokens: totalOutputTokens,
                    reasoningTokens: totalReasoningTokens,
                    totalTokens: totalInputTokens + totalOutputTokens,
                },
                coverage: getCoverageSummary(coverageTargets),
                verification: null,
                anomalies: buildAgentAnomalies({
                    steps: stepCount,
                    toolCalls: allToolCalls,
                    coverage: getCoverageSummary(coverageTargets),
                }),
                warnings: [],
            };
        }
        throw error;
    }
    clearTimeout(timeoutHandle);
    detachParentSignal();

    // ─── Done-tool extraction ───────────────────────────────────────────
    // If the model called submitResult, extract findings directly from
    // the validated tool args — no text parsing needed.
    const doneToolFindings = isSelfContained
        ? null
        : sanitizeFindingsResult(extractDoneToolResult<FindingsOutput>(result));

    if (doneToolFindings) {
        logger.log({
            message: `[AGENT-DONE-TOOL] Model called submitResult with ${doneToolFindings.suggestions?.length ?? 0} suggestions`,
            context: 'AgentLoop',
        });
    }

    // result.text may be empty if the model's last step was a tool call.
    // Fall back to accumulated step texts (e.g., from forced text steps 33/34).
    let finalText = result.text || '';
    if (!doneToolFindings && !finalText && allStepTexts.length > 0) {
        finalText = allStepTexts[allStepTexts.length - 1]; // Use last text step
        logger.log({
            message: `[AGENT-FALLBACK-TEXT] result.text empty, using last step text (${finalText.length} chars)`,
            context: 'AgentLoop',
        });
    }

    // Second chance: when the model hit MAX_STEPS without calling submitResult
    // and without producing text. Uses full response.messages for complete context.
    if (!doneToolFindings && !finalText && allToolCalls.length > 0) {
        logger.log({
            message: `[AGENT-SECOND-CHANCE] Agent finished ${allToolCalls.length} tool calls without submitResult or text. Retrying with full context.`,
            context: 'AgentLoop',
        });

        try {
            const secondChanceSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

            // Use full conversation history from result.response.messages
            // so the model has complete file contents, grep results, etc.
            const responseMessages: any[] = result?.response?.messages || [];

            const secondChanceResult: any = await throttledGenerateText({
                byokConfig: secrets.byokConfig,
                organizationId: input.telemetryMetadata?.organizationId,
                role: 'main',
                label: `${input.agentName ?? 'agent-loop'}-second-chance`,
                abortSignal: secondChanceSignal,
                queueTimeoutMs: secrets.byokQueueTimeoutMs,
                fn: () =>
                    generateText({
                        abortSignal: secondChanceSignal,
                        model: input.model,
                        system: withAnthropicCacheControl(
                            input.systemPrompt,
                            input.model,
                        ) as any,
                        experimental_telemetry: _buildLangfuseTelemetry(
                            `${input.agentName ?? 'agent-loop'}-second-chance`,
                            input.telemetryMetadata,
                        ),
                        providerOptions: buildProviderOptions(
                            `${input.agentName ?? 'agent-loop'}-second-chance`,
                            input.telemetryMetadata,
                            {
                                reasoningEffort: input.reasoningEffort,
                                reasoningConfigOverride:
                                    input.reasoningConfigOverride,
                                byokProvider: input.byokProvider,
                                modelName: (input.model as any)?.modelId,
                                openrouterProviderOrder:
                                    input.openrouterProviderOrder,
                                openrouterAllowFallbacks:
                                    input.openrouterAllowFallbacks,
                            },
                        ),
                        messages: [
                            // Original user prompt with diffs and PR context
                            {
                                role: 'user' as const,
                                content: input.userPrompt,
                            },
                            // Full conversation history: all tool calls + complete results
                            ...responseMessages,
                            // Instruction to finalize
                            {
                                role: 'user' as const,
                                content:
                                    'You have finished investigating. Respond NOW with your findings as JSON. ' +
                                    'Do NOT call any tools. If you found issues, include them. ' +
                                    'If no issues were found, return an empty suggestions array.',
                            },
                        ],
                        stopWhen: stepCountIs(1),
                    }),
            });

            finalText = secondChanceResult.text || '';

            // Track additional token usage (with cache breakdown).
            const scUsage = extractUsage(
                (secondChanceResult as any).totalUsage ??
                    secondChanceResult.usage ??
                    null,
            );
            totalInputTokens += scUsage.inputTokens;
            totalCacheReadTokens += scUsage.cacheReadTokens;
            totalCacheWriteTokens += scUsage.cacheWriteTokens;
            totalOutputTokens += scUsage.outputTokens;
            totalReasoningTokens += scUsage.reasoningTokens;

            if (finalText) {
                logger.log({
                    message: `[AGENT-SECOND-CHANCE] Got ${finalText.length} chars response`,
                    context: 'AgentLoop',
                });
            }
        } catch (err) {
            logger.warn({
                message: `[AGENT-SECOND-CHANCE] Follow-up call failed: ${err instanceof Error ? err.message : String(err)}`,
                context: 'AgentLoop',
            });
        }
    }

    if (allToolCalls.length === 0) {
        logger.warn({
            message: `[AGENT-NO-TOOLS] Agent responded without any tool calls (${result.steps?.length ?? 0} steps). Investigation was skipped.`,
            context: 'AgentLoop',
        });
    }

    logger.log({
        message: `[AGENT-FINAL] steps=${result.steps?.length ?? 0} finishReason=${result.finishReason} textLength=${finalText.length} toolCalls=${allToolCalls.length} hasJSON=${finalText.includes('"suggestions"')}`,
        context: 'AgentLoop',
        metadata: {
            steps: result.steps?.length ?? 0,
            finishReason: result.finishReason,
            textLength: finalText.length,
            toolCallsTotal: allToolCalls.length,
            textPreview: finalText.substring(0, 500),
        },
    });

    // Step 0: Use done-tool result if available (already schema-validated)
    let findings: FindingsOutput | null = doneToolFindings;
    let source: AgentLoopOutput['source'] = doneToolFindings
        ? 'json-parse'
        : 'empty';

    // Step 1: Try to parse JSON directly from the response text
    if (!findings) {
        findings = tryParseFindings(finalText);
        if (findings) source = 'json-parse';
    }

    // Step 2: If no JSON, use internal model to structure the text
    if (!findings && finalText.length > 50) {
        logger.log({
            message: `[AGENT-FALLBACK] No JSON in response, using internal model to structure text (${finalText.length} chars)`,
            context: 'AgentLoop',
        });

        const fallbackResult = await structureWithFallbackModel(
            finalText,
            secrets.byokConfig,
            input.telemetryMetadata?.organizationId,
            secrets.byokQueueTimeoutMs,
        );
        if (fallbackResult) {
            findings = fallbackResult.findings;
            totalInputTokens += fallbackResult.usage.inputTokens;
            totalCacheReadTokens += fallbackResult.usage.cacheReadTokens;
            totalCacheWriteTokens += fallbackResult.usage.cacheWriteTokens;
            totalOutputTokens += fallbackResult.usage.outputTokens;
            totalReasoningTokens += fallbackResult.usage.reasoningTokens;
            source = 'generate-object';
        } else {
            source = 'empty';
        }
    }

    if (!findings) {
        findings = {
            reasoning: finalText || 'No findings',
            suggestions: [],
        };
        source = 'empty';
    }

    // Defensive: ensure suggestions is always an array even when a
    // malformed done-tool or fallback produced a FindingsOutput without it.
    if (!Array.isArray(findings.suggestions)) {
        findings = { ...findings, suggestions: [] };
    }

    // Fast mode: skip heavy post-processing passes to keep latency low.
    // The main agent loop already ran with a capped step budget; spending
    // extra minutes on recovery/rescue/verify defeats the point of `--fast`.
    //
    // Self-contained mode: these passes all re-run the agent with tools,
    // which doesn't exist in trial flow. Skip them entirely.
    const isFastMode = input.reviewMode === 'fast';
    const skipHeavyPasses =
        isFastMode || isSelfContained || !!input.skipHeavyPasses;

    let coverageSummary = getCoverageSummary(coverageTargets);


    if (!skipHeavyPasses && !input.skipSynthesisRescue) {
        const synthesisRescue = await runSynthesisRescuePass({
            input,
            byokConfig: secrets.byokConfig,
            queueTimeoutMs: secrets.byokQueueTimeoutMs,
            findings,
            allToolCalls,
            totalInputTokens,
            totalCacheReadTokens,
            totalCacheWriteTokens,
            totalOutputTokens,
            totalReasoningTokens,
        });

        totalInputTokens = synthesisRescue.totalInputTokens;
        totalCacheReadTokens = synthesisRescue.totalCacheReadTokens;
        totalCacheWriteTokens = synthesisRescue.totalCacheWriteTokens;
        totalOutputTokens = synthesisRescue.totalOutputTokens;
        totalReasoningTokens = synthesisRescue.totalReasoningTokens;

        if (synthesisRescue.findings) {
            findings = mergeFindings(findings, synthesisRescue.findings);
            if (
                source === 'empty' &&
                synthesisRescue.findings.suggestions.length
            ) {
                source = 'json-parse';
            }
        }
    }

    // Severity filtering is applied in agent-review.stage.ts AFTER the
    // Gemini-based severity reclassification. We used to pre-filter here to
    // save verify tokens, but it ran on unreliable severity: for kody rules
    // the agent guesses severity without knowing the rule's configured value,
    // and for generalist findings the agent's rough severity can be flipped
    // by the reclassifier (e.g. "low" → "critical"). The pre-filter was
    // discarding findings that should have been kept.
    const isKodyRuleFinding = (s: (typeof findings.suggestions)[number]) =>
        typeof (s as any).ruleUuid === 'string' &&
        (s as any).ruleUuid.trim().length > 0;
    const discardedBySeverity: FindingsOutput['suggestions'] = [];

    let verificationUsage = {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
    };
    let droppedByVerify: FindingsOutput['suggestions'] = [];

    // Verify runs in normal, deep, and fast modes — dropping false
    // positives is worth the 10-30s it costs. It does NOT run in
    // self-contained mode because the verifier needs tools to inspect
    // code around each finding, and we don't have a sandbox there.
    //
    // Kody-rule findings bypass verify: they are deterministic user-authored
    // rules, so if the agent matched a ruleUuid the violation should surface.
    // The verifier is a false-positive guard for heuristic findings, not for
    // user-configured rules.
    if (
        !isSelfContained &&
        !skipHeavyPasses &&
        (findings.suggestions?.length ?? 0) > 0
    ) {
        const kodyRuleSuggestions = findings.suggestions.filter((s) =>
            isKodyRuleFinding(s),
        );
        const nonKodyRuleSuggestions = findings.suggestions.filter(
            (s) => !isKodyRuleFinding(s),
        );

        if (nonKodyRuleSuggestions.length > 0) {
            const verificationResult = await verifyFindingsWithTools({
                findings: {
                    ...findings,
                    suggestions: nonKodyRuleSuggestions,
                },
                input,
                secrets,
                allToolCalls,
                tools: pickVerificationTools(tools),
            });

            findings = {
                ...verificationResult.findings,
                suggestions: [
                    ...verificationResult.findings.suggestions,
                    ...kodyRuleSuggestions,
                ],
            };
            droppedByVerify = verificationResult.droppedByVerify || [];
            const vu = verificationResult.usage as any;
            totalInputTokens += vu.inputTokens ?? 0;
            totalCacheReadTokens += vu.cacheReadTokens ?? 0;
            totalCacheWriteTokens += vu.cacheWriteTokens ?? 0;
            totalOutputTokens += vu.outputTokens ?? 0;
            totalReasoningTokens += vu.reasoningTokens ?? 0;
            verificationTrace = verificationResult.trace;
            verificationUsage = {
                inputTokens: vu.inputTokens ?? 0,
                cacheReadTokens: vu.cacheReadTokens ?? 0,
                cacheWriteTokens: vu.cacheWriteTokens ?? 0,
                outputTokens: vu.outputTokens ?? 0,
                reasoningTokens: vu.reasoningTokens ?? 0,
            };

            if (kodyRuleSuggestions.length > 0) {
                logger.log({
                    message: `[AGENT-VERIFY] Bypassed verify for ${kodyRuleSuggestions.length} kody-rule finding(s); verified ${nonKodyRuleSuggestions.length} non-rule finding(s)`,
                    context: 'AgentLoop',
                });
            }
        } else if (kodyRuleSuggestions.length > 0) {
            logger.log({
                message: `[AGENT-VERIFY] Skipped verify — all ${kodyRuleSuggestions.length} finding(s) are kody rules`,
                context: 'AgentLoop',
            });
        }
    }

    // Base usage from the main agent loop. SDK totalUsage aggregates all
    // steps; individual step usage is accumulated into totalInputTokens.
    // We take whichever total is larger to avoid undercounting.
    const baseUsage = extractUsage(
        (result as any).totalUsage ?? result.usage ?? null,
    );

    // totalInputTokens/totalOutputTokens include second-chance + fallback overhead.
    // Since totalInputTokens starts at 0 and accumulates per-step + extras,
    // and baseUsage is the SDK's own total, use whichever is larger.
    const finalInputTokens = Math.max(baseUsage.inputTokens, totalInputTokens);
    const finalOutputTokens = Math.max(
        baseUsage.outputTokens,
        totalOutputTokens,
    );
    const finalReasoningTokens = Math.max(
        baseUsage.reasoningTokens,
        totalReasoningTokens,
    );
    const finalCacheReadTokens = Math.max(
        baseUsage.cacheReadTokens,
        totalCacheReadTokens,
    );
    const finalCacheWriteTokens = Math.max(
        baseUsage.cacheWriteTokens,
        totalCacheWriteTokens,
    );

    return {
        findings,
        text: finalText,
        steps: result.steps?.length ?? 0,
        toolCalls: allToolCalls,
        finishReason: result.finishReason,
        source,
        usage: {
            inputTokens: finalInputTokens,
            cacheReadTokens: finalCacheReadTokens,
            cacheWriteTokens: finalCacheWriteTokens,
            outputTokens: finalOutputTokens,
            reasoningTokens: finalReasoningTokens,
            totalTokens: finalInputTokens + finalOutputTokens,
        },
        discardedBySeverity,
        droppedByVerify,
        verificationUsage,
        coverage: coverageSummary,
        verification: verificationTrace,
        anomalies: buildAgentAnomalies({
            steps: result.steps?.length ?? 0,
            toolCalls: allToolCalls,
            coverage: coverageSummary,
        }),
        warnings: [],
    };
}

async function runSynthesisRescuePass(params: {
    input: AgentLoopInput;
    byokConfig?: BYOKConfig;
    queueTimeoutMs?: number;
    findings: FindingsOutput;
    allToolCalls: AgentLoopOutput['toolCalls'];
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}): Promise<{
    findings: FindingsOutput | null;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}> {
    const {
        input,
        byokConfig,
        queueTimeoutMs,
        findings,
        allToolCalls,
        totalInputTokens: initialTotalInputTokens,
        totalCacheReadTokens: initialTotalCacheReadTokens,
        totalCacheWriteTokens: initialTotalCacheWriteTokens,
        totalOutputTokens: initialTotalOutputTokens,
        totalReasoningTokens: initialTotalReasoningTokens,
    } = params;
    let totalInputTokens = initialTotalInputTokens;
    let totalCacheReadTokens = initialTotalCacheReadTokens;
    let totalCacheWriteTokens = initialTotalCacheWriteTokens;
    let totalOutputTokens = initialTotalOutputTokens;
    let totalReasoningTokens = initialTotalReasoningTokens;

    const safeSuggestions = findings.suggestions ?? [];

    const currentFindingsSummary = safeSuggestions.length
        ? safeSuggestions
              .map((suggestion, index) =>
                  [
                      `${index + 1}. ${suggestion.relevantFile}`,
                      suggestion.oneSentenceSummary ||
                          truncateText(suggestion.suggestionContent, 220),
                  ].join(' :: '),
              )
              .join('\n')
        : 'No findings reported yet.';

    const inspectedFilesSummary =
        allToolCalls.length > 0
            ? [...new Set(buildToolEvidenceSummary(allToolCalls).strongFiles)]
                  .slice(0, 24)
                  .join('\n')
            : 'No files were read.';

    const investigationSummary = allToolCalls
        .slice(-20)
        .map((toolCall) => {
            const args =
                typeof toolCall.args === 'string'
                    ? toolCall.args
                    : JSON.stringify(toolCall.args);
            return `${toolCall.toolName || toolCall.tool}(${args.substring(0, 180)}) => ${truncateText(toolCall.result || '(empty)', 240)}`;
        })
        .join('\n');
    const synthesisSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

    try {
        const synthesisResult = await throttledGenerateText({
            byokConfig,
            organizationId: input.telemetryMetadata?.organizationId,
            role: 'main',
            label: `${input.agentName ?? 'agent-loop'}-synthesis-rescue`,
            abortSignal: synthesisSignal,
            queueTimeoutMs,
            fn: () =>
                generateText({
                    abortSignal: synthesisSignal,
                    model: input.model,
                    experimental_telemetry: _buildLangfuseTelemetry(
                        `${input.agentName ?? 'agent-loop'}-synthesis-rescue`,
                        input.telemetryMetadata,
                    ),
                    providerOptions: buildProviderOptions(
                        `${input.agentName ?? 'agent-loop'}-synthesis-rescue`,
                        input.telemetryMetadata,
                        {
                            reasoningEffort: input.reasoningEffort,
                            reasoningConfigOverride:
                                input.reasoningConfigOverride,
                            byokProvider: input.byokProvider,
                            modelName: (input.model as any)?.modelId,
                            openrouterProviderOrder:
                                input.openrouterProviderOrder,
                            openrouterAllowFallbacks:
                                input.openrouterAllowFallbacks,
                        },
                    ),
                    system:
                        input.systemPrompt +
                        '\n\nIMPORTANT: This is a synthesis pass, not an exploration pass. Do NOT call tools. Re-evaluate the diff, call graph, inspected files, and current findings to detect at most one concrete missed bug.',
                    prompt: `${input.userPrompt}

<AlreadyInspectedFiles>
${inspectedFilesSummary}
</AlreadyInspectedFiles>

<RecentInvestigation>
${investigationSummary || 'No tool calls captured.'}
</RecentInvestigation>

<CurrentFindings>
${currentFindingsSummary}
</CurrentFindings>

Your task:
- Re-think the review based on the context above.
- Do not add variants or restatements of existing findings.
- Do not add speculative risks.
- If there are concrete missed bugs, return them.
- If there is no clearly missed bug, return an empty suggestions array.

Return ONLY JSON:
\`\`\`json
{
  "reasoning": "why there are or aren't concrete missed bugs",
  "suggestions": [
    {
      "label": "bug|security|performance",
      "relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact. HOW: concrete fix if clear from the code — omit if speculative.",
      "existingCode": "problematic code (only the lines that need to change, plus 1-2 surrounding lines for context)",
      "improvedCode": "fix (same scope as existingCode — only the changed lines plus 1-2 lines of context, NOT the entire function or block)",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
\`\`\``,
                    stopWhen: stepCountIs(1),
                }),
        });

        const synthesisText = synthesisResult.text || '';
        let extraFindings = tryParseFindings(synthesisText);

        if (!extraFindings && synthesisText.length > 50) {
            const fallbackResult = await structureWithFallbackModel(
                synthesisText,
                byokConfig,
                input.telemetryMetadata?.organizationId,
                queueTimeoutMs,
            );
            if (fallbackResult) {
                extraFindings = fallbackResult.findings;
                totalInputTokens += fallbackResult.usage.inputTokens;
                totalCacheReadTokens += fallbackResult.usage.cacheReadTokens;
                totalCacheWriteTokens += fallbackResult.usage.cacheWriteTokens;
                totalOutputTokens += fallbackResult.usage.outputTokens;
                totalReasoningTokens += fallbackResult.usage.reasoningTokens;
            }
        }

        const usage = extractUsage(
            synthesisResult.usage ??
                (synthesisResult as any).totalUsage ??
                null,
        );
        totalInputTokens += usage.inputTokens;
        totalCacheReadTokens += usage.cacheReadTokens;
        totalCacheWriteTokens += usage.cacheWriteTokens;
        totalOutputTokens += usage.outputTokens;
        totalReasoningTokens += usage.reasoningTokens;

        logger.log({
            message: `[AGENT-SYNTHESIS-RESCUE] before=${safeSuggestions.length} added=${extraFindings?.suggestions?.length ?? 0}`,
            context: 'AgentLoop',
            metadata: {
                currentFindings: safeSuggestions.length,
                addedFindings: extraFindings?.suggestions?.length ?? 0,
                inspectedFiles: inspectedFilesSummary
                    .split('\n')
                    .filter(Boolean).length,
                textPreview: truncateText(synthesisText, 320),
            },
        });

        return {
            findings: extraFindings,
            totalInputTokens,
            totalCacheReadTokens,
            totalCacheWriteTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    } catch (error) {
        logger.warn({
            message: `[AGENT-SYNTHESIS-RESCUE] Failed: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });

        return {
            findings: null,
            totalInputTokens,
            totalCacheReadTokens,
            totalCacheWriteTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    }
}

export function mergeFindings(
    base: FindingsOutput,
    extra: FindingsOutput,
): FindingsOutput {
    const baseSuggestions = base.suggestions ?? [];
    const extraSuggestions = extra.suggestions ?? [];

    const seen = new Set(
        baseSuggestions.map((suggestion) =>
            [
                suggestion.relevantFile,
                suggestion.relevantLinesStart ?? '',
                suggestion.relevantLinesEnd ?? '',
                suggestion.suggestionContent,
            ].join('::'),
        ),
    );

    const additionalSuggestions = extraSuggestions.filter((suggestion) => {
        const key = [
            suggestion.relevantFile,
            suggestion.relevantLinesStart ?? '',
            suggestion.relevantLinesEnd ?? '',
            suggestion.suggestionContent,
        ].join('::');

        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return {
        reasoning: [base.reasoning, extra.reasoning]
            .filter(Boolean)
            .join('\n\n'),
        suggestions: [...baseSuggestions, ...additionalSuggestions],
    };
}

async function verifyFindingsWithTools(params: {
    findings: FindingsOutput;
    input: AgentLoopInput;
    secrets: AgentLoopSecrets;
    allToolCalls: AgentLoopOutput['toolCalls'];
    tools: Record<string, any>;
}): Promise<{
    findings: FindingsOutput;
    droppedByVerify: FindingsOutput['suggestions'];
    trace: VerificationTraceSummary | null;
    usage: {
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
}> {
    const { findings, input, secrets, allToolCalls, tools } = params;
    const internalModel = getInternalModel(secrets.byokConfig);
    const reviewerEvidence = buildToolEvidenceSummary(allToolCalls);

    if (!internalModel || findings.suggestions.length === 0) {
        return {
            findings,
            droppedByVerify: [],
            trace: null,
            usage: {
                inputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
        };
    }

    try {
        const decisions = new Map<number, SuggestionVerificationDecision>();
        const verifierEvidenceByIndex = new Map<number, ToolEvidenceSummary>();
        const verifierParseModeByIndex = new Map<
            number,
            'direct' | 'fallback-llm' | 'default-keep'
        >();
        const verifierRawTextByIndex = new Map<number, string>();
        let totalInputTokens = 0;
        let totalCacheReadTokens = 0;
        let totalCacheWriteTokens = 0;
        let totalOutputTokens = 0;
        let totalReasoningTokens = 0;
        const decisionTraces: VerificationDecisionTrace[] = [];

        const reviewMode = params.input.reviewMode || 'normal';

        // Route each finding based on confidence + reviewMode.
        // Self-reported confidence doesn't correlate with correctness — the
        // model confidently hallucinates behavior of internal components —
        // so we always verify in normal mode. Confidence still decides
        // depth (light vs full), never whether to run.
        const toVerifyFull: Array<{ index: number; suggestion: any }> = [];
        const toVerifyLight: Array<{ index: number; suggestion: any }> = [];

        for (let i = 0; i < findings.suggestions.length; i++) {
            const suggestion = findings.suggestions[i];
            const confidence = suggestion.confidence ?? 5;

            if (reviewMode === 'deep') {
                toVerifyFull.push({ index: i, suggestion });
            } else if (confidence >= 5) {
                toVerifyLight.push({ index: i, suggestion });
            } else {
                toVerifyFull.push({ index: i, suggestion });
            }
        }

        logger.log({
            message: `[AGENT-VERIFY] Verifying ${toVerifyLight.length} light + ${toVerifyFull.length} full findings (mode=${reviewMode})`,
            context: 'AgentLoop',
        });

        // Light verify: 5 steps, tools available. Two steps was too tight —
        // the force-text cutoff (maxSteps-1) kicked in before the model had
        // room to synthesize, which forced every verification into the
        // second-chance fallback.
        const lightResults = await Promise.allSettled(
            toVerifyLight.map(({ index, suggestion }) => {
                return verifySingleFindingWithTools({
                    index,
                    suggestion,
                    input,
                    secrets,
                    allToolCalls,
                    tools,
                    maxVerifySteps: 5,
                });
            }),
        );

        for (let i = 0; i < lightResults.length; i++) {
            const result = lightResults[i];
            if (result.status !== 'fulfilled') continue;
            const vr = result.value;
            decisions.set(toVerifyLight[i].index, vr.decision);
            verifierEvidenceByIndex.set(toVerifyLight[i].index, vr.evidence);
            verifierParseModeByIndex.set(toVerifyLight[i].index, vr.parseMode);
            verifierRawTextByIndex.set(
                toVerifyLight[i].index,
                vr.rawTextPreview,
            );
            totalInputTokens += vr.usage.inputTokens;
            totalCacheReadTokens += (vr.usage as any).cacheReadTokens ?? 0;
            totalCacheWriteTokens += (vr.usage as any).cacheWriteTokens ?? 0;
            totalOutputTokens += vr.usage.outputTokens;
            totalReasoningTokens += vr.usage.reasoningTokens;
        }

        // Full verify: 10 steps, all tools. Used for deep mode and for
        // low-confidence findings (< 5) where we want the verifier to
        // investigate thoroughly before deciding keep/drop.
        const fullResults = await Promise.allSettled(
            toVerifyFull.map(({ index, suggestion }) => {
                return verifySingleFindingWithTools({
                    index,
                    suggestion,
                    input,
                    secrets,
                    allToolCalls,
                    tools,
                    maxVerifySteps: 10,
                });
            }),
        );

        for (let i = 0; i < fullResults.length; i++) {
            const result = fullResults[i];
            if (result.status !== 'fulfilled') continue;
            const vr = result.value;
            decisions.set(toVerifyFull[i].index, vr.decision);
            verifierEvidenceByIndex.set(toVerifyFull[i].index, vr.evidence);
            verifierParseModeByIndex.set(toVerifyFull[i].index, vr.parseMode);
            verifierRawTextByIndex.set(
                toVerifyFull[i].index,
                vr.rawTextPreview,
            );
            totalInputTokens += vr.usage.inputTokens;
            totalCacheReadTokens += (vr.usage as any).cacheReadTokens ?? 0;
            totalCacheWriteTokens += (vr.usage as any).cacheWriteTokens ?? 0;
            totalOutputTokens += vr.usage.outputTokens;
            totalReasoningTokens += vr.usage.reasoningTokens;
        }

        // Evidence gate: findings kept so far but without tool evidence
        // must go through full verification instead of being silently dropped.
        const toVerifyForEvidence: Array<{
            index: number;
            suggestion: any;
        }> = [];

        for (let i = 0; i < findings.suggestions.length; i++) {
            const decision = decisions.get(i);
            if (!decision || !decision.keep) continue;

            const hasEvidence =
                hasEvidenceForRelevantFile(
                    reviewerEvidence,
                    findings.suggestions[i].relevantFile,
                ) ||
                hasEvidenceForRelevantFile(
                    verifierEvidenceByIndex.get(i),
                    findings.suggestions[i].relevantFile,
                );

            if (!hasEvidence) {
                toVerifyForEvidence.push({
                    index: i,
                    suggestion: findings.suggestions[i],
                });
            }
        }

        if (toVerifyForEvidence.length > 0) {
            logger.log({
                message: `[EVIDENCE-GATE] ${toVerifyForEvidence.length} finding(s) kept without evidence — sending to full verification`,
                context: 'AgentLoop',
                metadata: {
                    indices: toVerifyForEvidence.map((e) => e.index),
                    files: toVerifyForEvidence.map(
                        (e) => e.suggestion.relevantFile,
                    ),
                },
            });

            const evidenceVerifyResults = await Promise.allSettled(
                toVerifyForEvidence.map(({ index, suggestion }) =>
                    verifySingleFindingWithTools({
                        index,
                        suggestion,
                        input,
                        secrets,
                        allToolCalls,
                        tools,
                    }),
                ),
            );

            for (let i = 0; i < evidenceVerifyResults.length; i++) {
                const result = evidenceVerifyResults[i];
                if (result.status !== 'fulfilled') continue;
                const vr = result.value;
                const idx = toVerifyForEvidence[i].index;
                decisions.set(idx, vr.decision);
                verifierEvidenceByIndex.set(idx, vr.evidence);
                verifierParseModeByIndex.set(idx, vr.parseMode);
                verifierRawTextByIndex.set(idx, vr.rawTextPreview);
                totalInputTokens += vr.usage.inputTokens;
                totalCacheReadTokens += (vr.usage as any).cacheReadTokens ?? 0;
                totalCacheWriteTokens +=
                    (vr.usage as any).cacheWriteTokens ?? 0;
                totalOutputTokens += vr.usage.outputTokens;
                totalReasoningTokens += vr.usage.reasoningTokens;
            }
        }

        let droppedByVerifier = 0;
        const droppedSuggestions: FindingsOutput['suggestions'] = [];

        const verifiedSuggestions = findings.suggestions
            .map((suggestion, index) => {
                const decision = decisions.get(index);
                if (!decision) return suggestion;
                if (!decision.keep) {
                    droppedByVerifier++;
                    droppedSuggestions.push(suggestion);
                    decisionTraces.push({
                        index,
                        relevantFile: suggestion.relevantFile,
                        action: 'drop',
                        parseMode:
                            verifierParseModeByIndex.get(index) ||
                            'default-keep',
                        rationale: truncateText(decision.rationale || '', 400),
                        confidence: decision.confidence,
                        verifierEvidence:
                            verifierEvidenceByIndex.get(index) ||
                            buildToolEvidenceSummary([]),
                        rawTextPreview: verifierRawTextByIndex.get(index) || '',
                    });
                    return null;
                }

                decisionTraces.push({
                    index,
                    relevantFile: suggestion.relevantFile,
                    action: 'keep',
                    parseMode:
                        verifierParseModeByIndex.get(index) || 'default-keep',
                    rationale: truncateText(decision.rationale || '', 400),
                    confidence: decision.confidence,
                    verifierEvidence:
                        verifierEvidenceByIndex.get(index) ||
                        buildToolEvidenceSummary([]),
                    rawTextPreview: verifierRawTextByIndex.get(index) || '',
                });

                return suggestion;
            })
            .filter(Boolean) as FindingsOutput['suggestions'];

        const sentToEvidenceGate = toVerifyForEvidence.length;

        logger.log({
            message: `[AGENT-VERIFY] Verified ${findings.suggestions.length} candidate findings, kept ${verifiedSuggestions.length}, dropped ${droppedByVerifier}`,
            context: 'AgentLoop',
            metadata: {
                suggestionsBefore: findings.suggestions.length,
                suggestionsAfter: verifiedSuggestions.length,
                droppedByVerifier,
                sentToEvidenceGate,
            },
        });

        return {
            findings: {
                reasoning:
                    droppedByVerifier > 0
                        ? `${findings.reasoning}\n\nFinal verifier kept ${verifiedSuggestions.length}/${findings.suggestions.length} candidate findings after tool-based verification.`
                        : findings.reasoning,
                suggestions: verifiedSuggestions,
            },
            droppedByVerify: droppedSuggestions,
            trace: {
                beforeCount: findings.suggestions.length,
                afterCount: verifiedSuggestions.length,
                droppedByVerifier,
                droppedByEvidenceFilter: 0,
                sentToEvidenceGate,
                decisions: decisionTraces,
            },
            usage: {
                inputTokens: totalInputTokens,
                cacheReadTokens: totalCacheReadTokens,
                cacheWriteTokens: totalCacheWriteTokens,
                outputTokens: totalOutputTokens,
                reasoningTokens: totalReasoningTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
            },
        };
    } catch (error) {
        logger.warn({
            message: `[AGENT-VERIFY] Final finding verification failed: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });

        return {
            findings,
            droppedByVerify: [],
            trace: null,
            usage: {
                inputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
        };
    }
}

async function verifySingleFindingWithTools(params: {
    index: number;
    suggestion: FindingsOutput['suggestions'][number];
    input: AgentLoopInput;
    secrets: AgentLoopSecrets;
    allToolCalls: AgentLoopOutput['toolCalls'];
    tools: Record<string, any>;
    maxVerifySteps?: number;
}): Promise<{
    decision: SuggestionVerificationDecision;
    evidence: ToolEvidenceSummary;
    parseMode: 'direct' | 'fallback-llm' | 'default-keep';
    rawTextPreview: string;
    usage: {
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
}> {
    const { index, suggestion, input, secrets, allToolCalls, tools } = params;
    const internalModel = getInternalModel(secrets.byokConfig);
    const evidenceBundle = buildSuggestionEvidenceBundle(
        index,
        suggestion,
        input.changedFiles,
        allToolCalls,
        input.callGraph,
    );

    logger.log({
        message: `[AGENT-VERIFY-CONTEXT] finding=${index} file=${suggestion.relevantFile} investigationLines=${evidenceBundle.relevantInvestigationCount} callGraphHintChars=${evidenceBundle.callGraphHint === 'N/A' ? 0 : evidenceBundle.callGraphHint.length}`,
        context: 'AgentLoop',
        metadata: {
            index,
            relevantFile: suggestion.relevantFile,
            relevantLinesStart: suggestion.relevantLinesStart,
            relevantLinesEnd: suggestion.relevantLinesEnd,
            investigationLines: evidenceBundle.relevantInvestigationCount,
            investigationLogPreview: truncateText(
                evidenceBundle.relevantInvestigationLog,
                320,
            ),
            callGraphHintChars:
                evidenceBundle.callGraphHint === 'N/A'
                    ? 0
                    : evidenceBundle.callGraphHint.length,
            callGraphHintPreview: truncateText(
                evidenceBundle.callGraphHint,
                320,
            ),
        },
    });

    if (!internalModel) {
        return {
            decision: {
                index,
                keep: true,
                rationale:
                    'No verifier model available; keeping finding by default.',
            },
            evidence: buildToolEvidenceSummary([]),
            parseMode: 'default-keep',
            rawTextPreview: '',
            usage: {
                inputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
        };
    }

    let finalText = '';
    let totalInputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let verifierSteps = 0;
    const verifierToolCalls: AgentLoopOutput['toolCalls'] = [];
    const verifierStepTexts: string[] = [];
    const verificationPrompt = buildVerifierPrompt(
        evidenceBundle.bundle,
        index,
    );
    const verifierSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

    const verificationRun: any = await throttledGenerateText({
        byokConfig: secrets.byokConfig,
        organizationId: input.telemetryMetadata?.organizationId,
        role: 'internal',
        label: `${input.agentName ?? 'agent-loop'}-verify-finding`,
        abortSignal: verifierSignal,
        queueTimeoutMs: secrets.byokQueueTimeoutMs,
        fn: () =>
            generateText({
                abortSignal: verifierSignal,
                model: internalModel as any,
                experimental_telemetry: _buildLangfuseTelemetry(
                    `${input.agentName ?? 'agent-loop'}-verify-finding`,
                    input.telemetryMetadata,
                ),
                providerOptions: buildProviderOptions(
                    `${input.agentName ?? 'agent-loop'}-verify-finding`,
                    input.telemetryMetadata,
                    {
                        reasoningEffort: input.reasoningEffort,
                        reasoningConfigOverride: input.reasoningConfigOverride,
                        byokProvider: input.byokProvider,
                        modelName: (internalModel as any)?.modelId,
                        openrouterProviderOrder: input.openrouterProviderOrder,
                        openrouterAllowFallbacks:
                            input.openrouterAllowFallbacks,
                    },
                ),
                system: verificationPrompt.system,
                prompt: verificationPrompt.prompt,
                tools: {
                    ...tools,
                    [DONE_TOOL_NAME]:
                        buildDoneTools(internalModel).verification,
                },
                stopWhen: [
                    hasToolCall(DONE_TOOL_NAME),
                    stepCountIs(params.maxVerifySteps || 10),
                ],
                prepareStep: ({ stepNumber }: any) => {
                    const maxSteps = params.maxVerifySteps || 10;
                    verifierSteps = stepNumber;
                    if (stepNumber >= maxSteps - 1) {
                        return {
                            toolChoice: 'none' as const,
                            activeTools: [],
                            system: 'You are a surgical code review verifier.\n\nIMPORTANT: Final step. Do NOT call tools. Return JSON only.',
                        };
                    }
                    return {};
                },
                onStepFinish: (event: any) => {
                    if (event.text) {
                        finalText = event.text;
                        verifierStepTexts.push(event.text);
                    }
                    if (event.usage) {
                        const u = extractUsage(event.usage);
                        totalInputTokens += u.inputTokens;
                        totalCacheReadTokens += u.cacheReadTokens;
                        totalCacheWriteTokens += u.cacheWriteTokens;
                        totalOutputTokens += u.outputTokens;
                        totalReasoningTokens += u.reasoningTokens;
                    }
                    if (event.toolCalls) {
                        const resultLookup = new Map<string, string>();
                        const toolResults: any[] = event.toolResults || [];

                        for (const tr of toolResults) {
                            const id = tr?.toolCallId || tr?.id || '';
                            const val =
                                tr?.result ?? tr?.output ?? tr?.content ?? '';
                            if (id) resultLookup.set(id, String(val));
                        }

                        for (const toolCall of event.toolCalls) {
                            const args =
                                (toolCall as any).args ||
                                (toolCall as any).input ||
                                {};
                            const callId =
                                (toolCall as any).toolCallId ||
                                (toolCall as any).id ||
                                '';
                            let resultStr = resultLookup.get(callId) || '';

                            if (
                                !resultStr &&
                                toolResults.length === event.toolCalls.length
                            ) {
                                const idx = event.toolCalls.indexOf(toolCall);
                                if (idx >= 0 && toolResults[idx]) {
                                    const tr = toolResults[idx];
                                    resultStr = String(
                                        tr?.result ??
                                            tr?.output ??
                                            tr?.content ??
                                            '',
                                    );
                                }
                            }

                            verifierToolCalls.push({
                                tool: toolCall.toolName,
                                toolName: toolCall.toolName,
                                args,
                                result: resultStr.substring(0, 500),
                            });

                            logger.log({
                                message: `[AGENT-VERIFY-TOOL] finding=${index} step=${verifierSteps} ${toolCall.toolName}(${JSON.stringify((toolCall as any).args || (toolCall as any).input || {}).substring(0, 180)})`,
                                context: 'AgentLoop',
                            });
                        }
                    }
                },
            }),
    });

    // ─── Done-tool extraction for verifier ─────────────────────────────
    const verifyDoneResult =
        extractDoneToolResult<z.infer<typeof _verificationSchema>>(
            verificationRun,
        );

    if (verifyDoneResult) {
        logger.log({
            message: `[AGENT-VERIFY-DONE-TOOL] finding=${index} verdict=${verifyDoneResult.keep ? 'keep' : 'drop'} via submitResult`,
            context: 'AgentLoop',
        });

        return {
            decision: {
                index: verifyDoneResult.index ?? index,
                keep: verifyDoneResult.keep,
                rationale: verifyDoneResult.rationale || '',
                confidence: verifyDoneResult.confidence,
            },
            evidence: buildToolEvidenceSummary(verifierToolCalls),
            parseMode: 'direct' as const,
            rawTextPreview: '',
            usage: {
                inputTokens: totalInputTokens,
                cacheReadTokens: totalCacheReadTokens,
                cacheWriteTokens: totalCacheWriteTokens,
                outputTokens: totalOutputTokens,
                reasoningTokens: totalReasoningTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
            },
        };
    }

    let verificationText =
        verificationRun.text ||
        finalText ||
        verifierStepTexts[verifierStepTexts.length - 1] ||
        verifierStepTexts.join('\n\n');

    // Second chance for verifier: use full response.messages context
    if (!verificationText && verifierToolCalls.length > 0) {
        try {
            const verifierSecondChanceSignal =
                timeoutSignal(LLM_CALL_TIMEOUT_MS);

            // Use full conversation history from the verifier run
            const verifierResponseMessages: any[] =
                verificationRun?.response?.messages || [];

            const secondChanceResult: any = await throttledGenerateText({
                byokConfig: secrets.byokConfig,
                organizationId: input.telemetryMetadata?.organizationId,
                role: 'internal',
                label: `${input.agentName ?? 'agent-loop'}-verify-finding-second-chance`,
                abortSignal: verifierSecondChanceSignal,
                queueTimeoutMs: secrets.byokQueueTimeoutMs,
                fn: () =>
                    generateText({
                        abortSignal: verifierSecondChanceSignal,
                        model: internalModel as any,
                        experimental_telemetry: _buildLangfuseTelemetry(
                            `${input.agentName ?? 'agent-loop'}-verify-finding-second-chance`,
                            input.telemetryMetadata,
                        ),
                        providerOptions: buildProviderOptions(
                            `${input.agentName ?? 'agent-loop'}-verify-finding-second-chance`,
                            input.telemetryMetadata,
                            {
                                reasoningEffort: input.reasoningEffort,
                                reasoningConfigOverride:
                                    input.reasoningConfigOverride,
                                byokProvider: input.byokProvider,
                                modelName: (internalModel as any)?.modelId,
                                openrouterProviderOrder:
                                    input.openrouterProviderOrder,
                                openrouterAllowFallbacks:
                                    input.openrouterAllowFallbacks,
                            },
                        ),
                        system: 'You are a surgical code review verifier.',
                        messages: [
                            // Original verification prompt with evidence
                            {
                                role: 'user' as const,
                                content: verificationPrompt.prompt,
                            },
                            // Full conversation history from verifier (tool calls + results)
                            ...verifierResponseMessages,
                            // Instruction to finalize
                            {
                                role: 'user' as const,
                                content:
                                    'You have finished investigating. Respond NOW with your verdict as JSON. Do NOT call any tools.\n\n' +
                                    `Return ONLY JSON:\n\`\`\`json\n{"index": ${index}, "keep": true, "rationale": "why", "confidence": "high|medium|low"}\n\`\`\``,
                            },
                        ],
                        stopWhen: stepCountIs(1),
                    }),
            });

            verificationText = secondChanceResult.text || verificationText;
            const scUsage = extractUsage(
                (secondChanceResult as any).totalUsage ??
                    secondChanceResult.usage ??
                    null,
            );
            totalInputTokens += scUsage.inputTokens;
            totalCacheReadTokens += scUsage.cacheReadTokens;
            totalCacheWriteTokens += scUsage.cacheWriteTokens;
            totalOutputTokens += scUsage.outputTokens;
            totalReasoningTokens += scUsage.reasoningTokens;

            if (verificationText) {
                logger.log({
                    message: `[AGENT-VERIFY-SECOND-CHANCE] finding=${index} recovered text response (full context)`,
                    context: 'AgentLoop',
                });
            }
        } catch (error) {
            logger.warn({
                message: `[AGENT-VERIFY-SECOND-CHANCE] finding=${index} failed: ${error instanceof Error ? error.message : String(error)}`,
                context: 'AgentLoop',
            });
        }
    }

    let decision = parseVerificationDecision(verificationText, index);
    let parseMode: 'direct' | 'fallback-llm' | 'default-keep' = 'direct';

    if (!decision && verificationText?.trim()) {
        const fallbackDecision =
            await structureVerificationDecisionWithFallbackModel(
                verificationText,
                index,
                secrets.byokConfig,
                input.telemetryMetadata?.organizationId,
                secrets.byokQueueTimeoutMs,
            );

        if (fallbackDecision) {
            decision = fallbackDecision.decision;
            parseMode = 'fallback-llm';
            totalInputTokens += fallbackDecision.usage.inputTokens;
            totalCacheReadTokens += fallbackDecision.usage.cacheReadTokens;
            totalCacheWriteTokens += fallbackDecision.usage.cacheWriteTokens;
            totalOutputTokens += fallbackDecision.usage.outputTokens;
            totalReasoningTokens += fallbackDecision.usage.reasoningTokens;

            logger.log({
                message: `[AGENT-VERIFY-FALLBACK] finding=${index} recovered verifier decision via LLM fallback`,
                context: 'AgentLoop',
            });
        }
    }

    const rawTextPreview = truncateText(verificationText || '', 600);
    if (!decision) {
        logger.warn({
            message: `[AGENT-VERIFY-DEFAULT-KEEP] finding=${index} verifier output was not parseable; keeping by default`,
            context: 'AgentLoop',
            metadata: {
                index,
                relevantFile: suggestion.relevantFile,
                rawTextPreview,
                verifierToolCalls: verifierToolCalls.length,
            },
        });
    }

    const baseUsage = extractUsage(
        verificationRun.usage ?? verificationRun.totalUsage ?? null,
    );

    const finalVerifyInput = Math.max(baseUsage.inputTokens, totalInputTokens);
    const finalVerifyOutput = Math.max(
        baseUsage.outputTokens,
        totalOutputTokens,
    );

    return {
        decision:
            decision ||
            ({
                index,
                keep: true,
                rationale:
                    'Verifier did not return a parseable verdict; keeping finding by default.',
            } satisfies SuggestionVerificationDecision),
        evidence: buildToolEvidenceSummary(verifierToolCalls),
        parseMode: decision ? parseMode : 'default-keep',
        rawTextPreview,
        usage: {
            inputTokens: finalVerifyInput,
            cacheReadTokens: Math.max(
                baseUsage.cacheReadTokens,
                totalCacheReadTokens,
            ),
            cacheWriteTokens: Math.max(
                baseUsage.cacheWriteTokens,
                totalCacheWriteTokens,
            ),
            outputTokens: finalVerifyOutput,
            reasoningTokens: Math.max(
                baseUsage.reasoningTokens,
                totalReasoningTokens,
            ),
            totalTokens: finalVerifyInput + finalVerifyOutput,
        },
    };
}

export function buildVerifierPrompt(
    evidenceBundle: string,
    index: number,
): {
    system: string;
    prompt: string;
} {
    return {
        system: `You are a surgical code review verifier.

Your task is to verify ONE candidate finding: confirm or REFUTE its technical claim.
You are NOT re-deciding whether it is "worth reporting" — the finder already promoted it.
Your job is correctness, not taste. The bar to remove a finding is a REFUTATION, not a doubt.

Rules:
- You may use only a few tool calls. Be surgical.
- Use tools to confirm or REFUTE the candidate finding.
- Treat call graph hints as fast navigation hints, not as final proof.
- You must NOT create a new finding unrelated to the candidate.
- Do NOT rewrite the finding text, summary, severity, or suggested fix.

DROP the finding ONLY if you can actively REFUTE it — concrete evidence that it is wrong or cannot happen:
- The root cause described is factually wrong (e.g. claims something is not imported when it is; claims a value can be null when it provably cannot).
- The failure path is impossible given the actual code: a guard upstream prevents it, the branch is unreachable, or the value is already validated before use.
- It is pure code style, naming, documentation, or formatting — not a behavior bug.
- It is a generic "missing X" suggestion (missing rate limit / validation / CSRF / auth) with NO concrete code path where the omission produces a wrong outcome.

KEEP the finding (this is the DEFAULT) whenever you cannot refute it. Do NOT drop a finding merely because:
- the trigger is concurrent, adversarial, or an edge condition — race conditions, SSRF, auth/FIPS bypass, and injection are REAL bugs, not "speculative" or "extreme";
- the root cause is reached from a caller in another file — cross-file bugs are real; trace the path before judging;
- the bug is not literally on a changed line, as long as the PR's change activates, exposes, or fails to guard it.

When in doubt, KEEP — a human reviewer makes the final call. Recall of real defects matters more here than trimming the last few low-value findings.

Return JSON only at the end.`,
        prompt: `${evidenceBundle}

You may use up to 4 tool-call steps.

Recommended approach:
1. Read the cited file/range if needed.
2. Search for the key symbol or caller if the claim depends on flow.
3. Read one relevant caller/callee file if needed.
4. Return a final JSON verdict.

Output JSON:
\`\`\`json
{
  "index": ${index},
  "keep": true,
  "rationale": "why the evidence supports keep/drop",
  "confidence": "high|medium|low"
}
\`\`\`
`,
    };
}

function pickVerificationTools(
    tools: Record<string, any>,
): Record<string, any> {
    const allowed = ['grep', 'readFile', 'checkTypes', 'searchDocs'];
    return Object.fromEntries(
        Object.entries(tools).filter(([name]) => allowed.includes(name)),
    );
}

function buildSuggestionEvidenceBundle(
    index: number,
    suggestion: FindingsOutput['suggestions'][number],
    changedFiles: FileChange[] = [],
    allToolCalls: AgentLoopOutput['toolCalls'],
    callGraph?: string,
): SuggestionEvidenceBundle {
    const file = changedFiles.find(
        (changedFile) => changedFile.filename === suggestion.relevantFile,
    );
    const basename =
        suggestion.relevantFile.split('/').pop() || suggestion.relevantFile;
    const relevantToolCalls = allToolCalls
        .filter((toolCall) => {
            const args = JSON.stringify(toolCall.args || {});
            const result = toolCall.result || '';
            return (
                args.includes(suggestion.relevantFile) ||
                args.includes(basename) ||
                result.includes(suggestion.relevantFile) ||
                result.includes(basename)
            );
        })
        .slice(-8)
        .map((toolCall) => {
            const args =
                typeof toolCall.args === 'string'
                    ? toolCall.args
                    : JSON.stringify(toolCall.args);
            return `- ${toolCall.toolName || toolCall.tool}(${truncateText(args, 180)}) => ${truncateText(toolCall.result || '(empty)', 280)}`;
        });

    const diffSnippet = truncateText(
        file?.patchWithLinesStr || file?.patch || '',
        1800,
    );
    const fileSnippet = truncateText(
        extractFileWindow(
            file?.fileContent || '',
            suggestion.relevantLinesStart,
            suggestion.relevantLinesEnd,
        ),
        1600,
    );
    const callGraphSnippet = truncateText(
        extractRelevantCallGraphContext(callGraph, suggestion),
        1400,
    );

    const relevantInvestigationLog =
        relevantToolCalls.length > 0
            ? relevantToolCalls.join('\n')
            : '- No file-specific tool log found';
    const callGraphHint = callGraphSnippet || 'N/A';

    return {
        relevantInvestigationLog,
        relevantInvestigationCount: relevantToolCalls.length,
        callGraphHint,
        bundle: `<Finding index="${index}">
File: ${suggestion.relevantFile}
Lines: ${suggestion.relevantLinesStart ?? 'unknown'}-${suggestion.relevantLinesEnd ?? 'unknown'}
Candidate hypothesis (may be wrong):
Summary: ${suggestion.oneSentenceSummary || 'N/A'}
${suggestion.suggestionContent}

Existing code:
\`\`\`
${truncateText(suggestion.existingCode || '', 800)}
\`\`\`

Diff snippet:
\`\`\`diff
${diffSnippet || 'N/A'}
\`\`\`

File snippet:
\`\`\`
${fileSnippet || 'N/A'}
\`\`\`

Relevant investigation log:
${relevantInvestigationLog}

Call graph hints:
\`\`\`text
${callGraphHint}
\`\`\`
</Finding>`,
    };
}

function buildToolEvidenceSummary(
    toolCalls: AgentLoopOutput['toolCalls'],
): ToolEvidenceSummary {
    const strongFiles = new Set<string>();
    const weakFiles = new Set<string>();

    for (const toolCall of toolCalls) {
        const normalizedTool = (toolCall.toolName || toolCall.tool || '')
            .trim()
            .toLowerCase();
        const args = (toolCall.args || {}) as Record<string, unknown>;

        if (normalizedTool === 'readfile' || normalizedTool === 'checktypes') {
            const explicitPath =
                (args.path as string) ||
                (args.filePath as string) ||
                (args.file as string) ||
                '';
            const normalizedPath = normalizeFilePath(explicitPath);
            if (normalizedPath) {
                strongFiles.add(normalizedPath);
            }
        }

        if (normalizedTool === 'grep' && typeof toolCall.result === 'string') {
            for (const resultLine of toolCall.result.split('\n')) {
                const match = resultLine.match(/^([^:]+):\d+:/);
                if (!match?.[1]) continue;
                const normalizedPath = normalizeFilePath(match[1]);
                if (normalizedPath) {
                    weakFiles.add(normalizedPath);
                }
            }
        }
    }

    return {
        strongFiles: [...strongFiles],
        weakFiles: [...weakFiles],
    };
}

function buildAgentAnomalies(params: {
    steps: number;
    toolCalls: AgentLoopOutput['toolCalls'];
    coverage: CoverageSummary;
}): AgentAnomalySummary {
    const { steps, toolCalls, coverage } = params;
    const evidence = buildToolEvidenceSummary(toolCalls);
    const touchedTargets = coverage?.touchedTargets || 0;
    const totalTargets = coverage?.totalTargets || 0;
    const coveragePct = totalTargets > 0 ? touchedTargets / totalTargets : 0;

    return {
        stepsLe2: steps <= 2,
        zeroToolCalls: toolCalls.length === 0,
        zeroStrongEvidenceFiles: evidence.strongFiles.length === 0,
        zeroCoverage: touchedTargets === 0,
        lowCoverage: totalTargets > 0 && coveragePct < 0.7,
        lowStrongEvidenceFiles:
            totalTargets >= 2 && evidence.strongFiles.length < 2,
    };
}

function hasEvidenceForRelevantFile(
    evidence: ToolEvidenceSummary | undefined,
    relevantFile: string,
): boolean {
    if (!evidence || !relevantFile) return false;

    return [...evidence.strongFiles, ...evidence.weakFiles].some((candidate) =>
        pathsReferToSameFile(candidate, relevantFile),
    );
}

function normalizeFilePath(filePath: string): string {
    if (!filePath) return '';
    return filePath
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .trim()
        .toLowerCase();
}

function pathsReferToSameFile(
    candidate: string,
    relevantFile: string,
): boolean {
    const normalizedCandidate = normalizeFilePath(candidate);
    const normalizedRelevant = normalizeFilePath(relevantFile);

    if (!normalizedCandidate || !normalizedRelevant) return false;
    if (normalizedCandidate === normalizedRelevant) return true;

    return (
        normalizedCandidate.endsWith(`/${normalizedRelevant}`) ||
        normalizedRelevant.endsWith(`/${normalizedCandidate}`)
    );
}

function extractRelevantCallGraphContext(
    callGraph: string | undefined,
    suggestion: FindingsOutput['suggestions'][number],
): string {
    if (!callGraph?.trim()) return '';

    const normalizedRelevantFile = normalizeFilePath(suggestion.relevantFile);
    const basename = normalizedRelevantFile.split('/').pop() || '';
    const shortPath = normalizedRelevantFile.split('/').slice(-2).join('/');
    const symbolHints = extractSuggestionHintTokens(suggestion);

    const rawSections = callGraph
        .split(/\n{2,}/)
        .map((section) => section.trim())
        .filter(Boolean);

    if (rawSections.length === 0) return '';

    const heading = rawSections[0].toLowerCase().startsWith('changed functions')
        ? rawSections[0]
        : '';
    const sections = heading ? rawSections.slice(1) : rawSections;

    const rankedSections = sections
        .map((section) => {
            const lower = section.toLowerCase();
            let score = 0;

            if (shortPath && lower.includes(shortPath)) score += 5;
            if (basename && lower.includes(basename)) score += 4;

            for (const token of symbolHints) {
                if (lower.includes(token)) score += 1;
            }

            return { section, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

    if (rankedSections.length === 0) {
        return '';
    }

    return [
        heading,
        ...rankedSections.slice(0, 3).map((entry) => entry.section),
    ]
        .filter(Boolean)
        .join('\n\n');
}

function extractSuggestionHintTokens(
    suggestion: FindingsOutput['suggestions'][number],
): string[] {
    const commonNoise = new Set([
        'what',
        'why',
        'how',
        'this',
        'that',
        'with',
        'from',
        'into',
        'when',
        'where',
        'null',
        'true',
        'false',
        'return',
        'const',
        'class',
        'function',
        'async',
        'await',
        'string',
        'number',
        'error',
        'value',
        'result',
        'line',
        'code',
    ]);

    const text = [
        suggestion.oneSentenceSummary,
        suggestion.suggestionContent,
        suggestion.existingCode,
        suggestion.improvedCode,
    ]
        .filter(Boolean)
        .join('\n');

    const tokens =
        text
            .match(/[A-Za-z_][A-Za-z0-9_]{3,}/g)
            ?.map((token) => token.toLowerCase()) || [];

    return [...new Set(tokens)]
        .filter((token) => !commonNoise.has(token))
        .slice(0, 10);
}

function parseVerificationDecision(
    text: string,
    index: number,
): SuggestionVerificationDecision | null {
    if (!text) return null;

    const tryParse = (raw: string): SuggestionVerificationDecision | null => {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.keep !== 'boolean') return null;
            return {
                index: typeof parsed.index === 'number' ? parsed.index : index,
                keep: parsed.keep,
                rationale: parsed.rationale || '',
                confidence: parsed.confidence,
            };
        } catch {
            return null;
        }
    };

    try {
        const parsed: any = EnhancedJSONParser.parse(text);
        if (parsed && typeof parsed.keep === 'boolean') {
            return {
                index: typeof parsed.index === 'number' ? parsed.index : index,
                keep: parsed.keep,
                rationale: parsed.rationale || '',
                confidence: parsed.confidence,
            };
        }
    } catch {
        // fall through
    }

    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
        const parsed = tryParse(codeBlockMatch[1].trim());
        if (parsed) return parsed;
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const parsed = tryParse(text.substring(firstBrace, lastBrace + 1));
        if (parsed) return parsed;
    }

    return null;
}

async function structureVerificationDecisionWithFallbackModel(
    verificationText: string,
    index: number,
    byokConfig?: BYOKConfig,
    organizationId?: string,
    queueTimeoutMs?: number,
): Promise<{
    decision: SuggestionVerificationDecision;
    usage: {
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
} | null> {
    const verifierFallbackSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);
    try {
        const result: any = await withStructuredOutputFallback(
            { byokConfig, organizationId, label: 'verify-structure-fallback' },
            (internalModel) =>
                throttledGenerateText({
                    byokConfig,
                    organizationId,
                    role: 'internal',
                    label: 'verify-structure-fallback',
                    abortSignal: verifierFallbackSignal,
                    queueTimeoutMs,
                    fn: () =>
                        generateText({
                            abortSignal: verifierFallbackSignal,
                            model: internalModel as any,
                            experimental_telemetry: _buildLangfuseTelemetry(
                                'verify-structure-fallback',
                            ),
                            output: Output.object({
                                schema: jsonSchema({
                                    type: 'object',
                                    properties: {
                                        index: { type: 'number' },
                                        keep: { type: 'boolean' },
                                        rationale: { type: 'string' },
                                        confidence: {
                                            type: 'string',
                                            enum: ['high', 'medium', 'low'],
                                        },
                                    },
                                    required: ['keep', 'rationale'],
                                }),
                            }) as any,
                            system: `You are a JSON extraction assistant.

You receive the raw text output of a code-review verifier and must extract only its final verdict.

Rules:
- Recover the verifier's intended keep/drop decision exactly when possible.
- Do not invent a new bug or a new rationale not supported by the text.
- Preserve refined suggestion text only if the verifier clearly provided it.
- If the text contains uncertainty, keep the rationale faithful to that uncertainty.
- Output only the structured decision object.`,
                            prompt: `Extract the verifier verdict from this text:

---
${verificationText}
---

Return:
- index
- keep
- rationale
- confidence (if present)`,
                        }),
                }),
        );

        const output: any = (result as any).object ?? (result as any).output;
        const coerceKeep = (value: unknown): boolean | null => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (normalized === 'true') return true;
                if (normalized === 'false') return false;
            }
            return null;
        };

        let keep = coerceKeep(output?.keep);
        let rationale = output?.rationale || '';
        let confidence = output?.confidence;

        if (keep === null && typeof result?.text === 'string') {
            const parsedFromText = parseVerificationDecision(
                result.text,
                index,
            );
            if (parsedFromText) {
                keep = parsedFromText.keep;
                rationale = parsedFromText.rationale || '';
                confidence = parsedFromText.confidence;
            }
        }

        if (keep === null) {
            return null;
        }

        const fallbackUsage = extractUsage(
            result.usage ?? (result as any).totalUsage ?? null,
        );

        return {
            decision: {
                index: typeof output?.index === 'number' ? output.index : index,
                keep,
                rationale,
                confidence,
            },
            usage: {
                inputTokens: fallbackUsage.inputTokens,
                cacheReadTokens: fallbackUsage.cacheReadTokens,
                cacheWriteTokens: fallbackUsage.cacheWriteTokens,
                outputTokens: fallbackUsage.outputTokens,
                reasoningTokens: fallbackUsage.reasoningTokens,
                totalTokens:
                    fallbackUsage.inputTokens + fallbackUsage.outputTokens,
            },
        };
    } catch (error) {
        if (error instanceof NoStructuredFallbackModelError) {
            logger.warn({
                message:
                    '[AGENT-VERIFY-FALLBACK] No internal model available for verifier fallback',
                context: 'AgentLoop',
            });
            return null;
        }
        logger.error({
            message: `[AGENT-VERIFY-FALLBACK] Failed to structure verifier output: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });
        return null;
    }
}

function extractFileWindow(
    fileContent: string,
    startLine?: number,
    endLine?: number,
    padding = 12,
): string {
    if (!fileContent) return '';
    if (!startLine || startLine <= 0) {
        return fileContent.split('\n').slice(0, 80).join('\n');
    }

    const lines = fileContent.split('\n');
    const start = Math.max(0, startLine - padding - 1);
    const end = Math.min(lines.length, (endLine || startLine) + padding);
    return lines
        .slice(start, end)
        .map((line, index) => `${start + index + 1}: ${line}`)
        .join('\n');
}

function truncateText(text: string, maxChars: number): string {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.substring(0, maxChars)}...`;
}

/**
 * Try to parse findings JSON from the model's text response.
 */
function tryParseFindings(text: string): FindingsOutput | null {
    if (!text) return null;

    // Strategy 1: EnhancedJSONParser (handles code blocks, json5, jsonrepair)
    try {
        const parsed: any = EnhancedJSONParser.parse(text);
        if (parsed?.suggestions && Array.isArray(parsed.suggestions)) {
            return {
                reasoning: parsed.reasoning || '',
                suggestions: parsed.suggestions,
            };
        }
    } catch {
        // Not valid JSON — try next strategy
    }

    // Strategy 2: Extract JSON from markdown code blocks manually
    // Some models wrap JSON in ```json ... ``` with text before/after that confuses the parser
    try {
        const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (codeBlockMatch?.[1]) {
            const jsonStr = codeBlockMatch[1].trim();
            const parsed = JSON.parse(jsonStr);
            if (parsed?.suggestions && Array.isArray(parsed.suggestions)) {
                return {
                    reasoning: parsed.reasoning || '',
                    suggestions: parsed.suggestions,
                };
            }
        }
    } catch {
        // Malformed JSON in code block
    }

    // Strategy 3: Find the outermost { ... } that contains "suggestions"
    try {
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            const jsonStr = text.substring(firstBrace, lastBrace + 1);
            if (jsonStr.includes('"suggestions"')) {
                const parsed = JSON.parse(jsonStr);
                if (parsed?.suggestions && Array.isArray(parsed.suggestions)) {
                    return {
                        reasoning: parsed.reasoning || '',
                        suggestions: parsed.suggestions,
                    };
                }
            }
        }
    } catch {
        // Still not parseable — will go to fallback
    }

    return null;
}

/**
 * Check if text looks like it contains actual findings vs just investigation notes.
 * Used to gate the fallback LLM — prevents fabricating suggestions from
 * "I'm looking at file X..." investigation text.
 */
function looksLikeFindings(text: string): boolean {
    const lower = text.toLowerCase();
    // Must mention at least 2 of these to look like actual findings
    const signals = [
        /\b(bug|issue|vulnerability|problem|error|flaw|defect)\b/,
        /\b(fix|should|must|incorrect|missing|broken|unsafe|race condition)\b/,
        /\b(line\s*\d+|\.ts\b|\.js\b|\.go\b|\.rb\b|\.py\b)/,
        /\b(severity|critical|high|medium|low)\b/,
        /\b(existing.?code|improved.?code|suggestion)\b/,
        /```/,
    ];
    const matches = signals.filter((r) => r.test(lower)).length;
    return matches >= 2;
}

/**
 * Use a cheap, fast model to structure free-text review into JSON.
 * This is the fallback when the BYOK model doesn't output JSON.
 */
async function structureWithFallbackModel(
    reviewText: string,
    byokConfig?: BYOKConfig,
    organizationId?: string,
    queueTimeoutMs?: number,
): Promise<{
    findings: FindingsOutput;
    usage: {
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
} | null> {
    try {
        const nullableStringSchema = {
            type: ['string', 'null'] as ('string' | 'null')[],
        };
        const nullableNumberSchema = {
            type: ['number', 'null'] as ('number' | 'null')[],
        };
        const nullableLabelSchema = {
            anyOf: [
                {
                    type: 'string' as const,
                    enum: ['bug', 'security', 'performance'],
                },
                { type: 'null' as const },
            ],
        };
        const nullableSeveritySchema = {
            anyOf: [
                {
                    type: 'string' as const,
                    enum: ['critical', 'high', 'medium', 'low'],
                },
                { type: 'null' as const },
            ],
        };
        const structureFallbackSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

        const result: any = await withStructuredOutputFallback(
            { byokConfig, organizationId, label: 'review-structure-fallback' },
            (internalModel) =>
                throttledGenerateText({
                    byokConfig,
                    organizationId,
                    role: 'internal',
                    label: 'review-structure-fallback',
                    abortSignal: structureFallbackSignal,
                    queueTimeoutMs,
                    fn: () =>
                        generateText({
                            abortSignal: structureFallbackSignal,
                            model: internalModel as any,
                            experimental_telemetry: _buildLangfuseTelemetry(
                                'review-structure-fallback',
                            ),
                            output: Output.object({
                                schema: jsonSchema({
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        reasoning: { type: 'string' },
                                        suggestions: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                additionalProperties: false,
                                                properties: {
                                                    relevantFile: {
                                                        type: 'string',
                                                    },
                                                    language:
                                                        nullableStringSchema,
                                                    label: nullableLabelSchema,
                                                    suggestionContent: {
                                                        type: 'string',
                                                    },
                                                    existingCode: {
                                                        type: 'string',
                                                    },
                                                    improvedCode: {
                                                        type: 'string',
                                                    },
                                                    oneSentenceSummary:
                                                        nullableStringSchema,
                                                    relevantLinesStart:
                                                        nullableNumberSchema,
                                                    relevantLinesEnd:
                                                        nullableNumberSchema,
                                                    severity:
                                                        nullableSeveritySchema,
                                                },
                                                required: [
                                                    'relevantFile',
                                                    'language',
                                                    'label',
                                                    'suggestionContent',
                                                    'existingCode',
                                                    'improvedCode',
                                                    'oneSentenceSummary',
                                                    'relevantLinesStart',
                                                    'relevantLinesEnd',
                                                    'severity',
                                                ],
                                            },
                                        },
                                    },
                                    required: ['reasoning', 'suggestions'],
                                }),
                            }) as any,
                            system: `You are a JSON extraction assistant. You receive code review text and extract structured findings.

Rules:
- Extract EVERY issue/bug/vulnerability mentioned into a separate suggestion
- Use exact file paths from the text (e.g. "src/auth/login.ts", not just "login.ts")
- Copy code snippets exactly as written in the text
- If line numbers are mentioned, include them
- If no issues found, return empty suggestions array
- Never invent issues not in the text`,
                            prompt: `Extract all code review findings from this text:

---
${reviewText}
---

For each issue found, extract: relevantFile, language, label (bug/security/performance when present), suggestionContent (full description), existingCode, improvedCode, oneSentenceSummary, relevantLinesStart, relevantLinesEnd, severity (critical/high/medium/low).`,
                        }),
                }),
        );

        const rawOutput: any = (result as any).object ?? (result as any).output;
        const output = {
            reasoning: rawOutput?.reasoning ?? '',
            suggestions: Array.isArray(rawOutput?.suggestions)
                ? rawOutput.suggestions.map((suggestion: any) => ({
                      relevantFile: suggestion?.relevantFile ?? '',
                      suggestionContent: suggestion?.suggestionContent ?? '',
                      existingCode: suggestion?.existingCode ?? '',
                      improvedCode: suggestion?.improvedCode ?? '',
                      ...(suggestion?.language == null
                          ? {}
                          : { language: suggestion.language }),
                      ...(suggestion?.label == null
                          ? {}
                          : { label: suggestion.label }),
                      ...(suggestion?.oneSentenceSummary == null
                          ? {}
                          : {
                                oneSentenceSummary:
                                    suggestion.oneSentenceSummary,
                            }),
                      ...(suggestion?.relevantLinesStart == null
                          ? {}
                          : {
                                relevantLinesStart:
                                    suggestion.relevantLinesStart,
                            }),
                      ...(suggestion?.relevantLinesEnd == null
                          ? {}
                          : {
                                relevantLinesEnd: suggestion.relevantLinesEnd,
                            }),
                      ...(suggestion?.severity == null
                          ? {}
                          : { severity: suggestion.severity }),
                  }))
                : [],
        };

        const fallbackUsage = extractUsage(
            result.usage ?? (result as any).totalUsage ?? null,
        );

        logger.log({
            message: `[AGENT-FALLBACK] structured output returned ${output?.suggestions?.length ?? 0} suggestions (input=${fallbackUsage.inputTokens}, cacheRead=${fallbackUsage.cacheReadTokens}, output=${fallbackUsage.outputTokens})`,
            context: 'AgentLoop',
        });

        return {
            findings: output as FindingsOutput,
            usage: {
                inputTokens: fallbackUsage.inputTokens,
                cacheReadTokens: fallbackUsage.cacheReadTokens,
                cacheWriteTokens: fallbackUsage.cacheWriteTokens,
                outputTokens: fallbackUsage.outputTokens,
                reasoningTokens: fallbackUsage.reasoningTokens,
                totalTokens:
                    fallbackUsage.inputTokens + fallbackUsage.outputTokens,
            },
        };
    } catch (error) {
        if (error instanceof NoStructuredFallbackModelError) {
            logger.warn({
                message:
                    '[AGENT-FALLBACK] No internal model available for fallback',
                context: 'AgentLoop',
            });
            return null;
        }
        logger.error({
            message: `[AGENT-FALLBACK] generateObject failed`,
            context: 'AgentLoop',
            error,
        });
        return null;
    }
}

// Tools are defined in agent-tools.factory.ts (buildAgentTools)
