/**
 * Provider-specific reasoning/thinking `providerOptions` for a Vercel AI SDK
 * `generateText` call — domain-agnostic.
 *
 * Maps a normalized effort level ('none'|'low'|'medium'|'high') to each BYOK
 * provider's native thinking format, and layers OpenRouter provider-pinning on
 * top. No review/agent shapes — any caller building a model request can use it.
 */
import { BYOKProvider } from '@kodus/kodus-common/llm';
import { createLogger } from '@libs/core/log/logger';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import { resolveAnthropicModelTraits } from '@libs/llm/anthropic-model-traits';

const logger = createLogger('ReasoningOptions');

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 5_000,
    medium: 15_000,
    high: 40_000,
};

/**
 * Build provider-specific reasoning `providerOptions` for a generateText call.
 * Telemetry metadata is no longer merged here — callers pass
 * `telemetry: buildLangfuseTelemetry(runName, meta)` separately.
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

/**
 * Build provider-specific reasoning/thinking options for generateText.
 *
 * Maps a normalized effort level to each provider's native format:
 *   - Anthropic: per model generation — see `anthropic-model-traits.ts`
 *   - Google Gemini 3+: thinkingConfig.thinkingLevel (minimal/low/medium/high)
 *   - Google Gemini 2.5: thinkingConfig.thinkingBudget
 *   - OpenAI o-series: reasoningEffort (low/medium/high)
 *   - OpenRouter: reasoning.effort (normalized across providers)
 *   - Kimi/GLM/others via OPENAI_COMPATIBLE: thinking.type enabled/disabled
 *
 * `modelName` is not optional in practice for Anthropic: the provider alone
 * cannot tell an Opus 5 from a Sonnet 4.5, and the two accept mutually
 * exclusive thinking shapes.
 *
 * Defaults when nothing configured: thinking stays OFF for all providers —
 * which for Anthropic means saying `disabled` out loud, since its newest
 * models think unless told not to.
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
    if (!provider) return {};

    // Anthropic is the only provider where "off" needs to be said out loud:
    // Opus 5, Sonnet 5 and Fable 5 think by default, so omitting the config
    // leaves thinking ON for a user who explicitly picked Off.
    if (provider === BYOKProvider.ANTHROPIC && (!effort || effort === 'none')) {
        return buildAnthropicThinkingOff(modelName);
    }

    if (!effort || effort === 'none') return {};

    switch (provider) {
        case BYOKProvider.ANTHROPIC:
            return buildAnthropicReasoning(effort, modelName);

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

/**
 * Map an effort tier onto the thinking shape the given Claude accepts.
 *
 * The three generations are mutually exclusive on the wire: sending
 * `budgetTokens` to a 4.7+ model is a 400, and sending `type: 'adaptive'` to a
 * pre-4.6 model is a 400 too. When the model can't be identified we send
 * nothing — a review that runs without thinking beats a review that dies on a
 * request the provider rejects outright.
 */
function buildAnthropicReasoning(
    effort: Exclude<ReasoningEffort, 'none'>,
    modelName?: string,
): Record<string, any> {
    const traits = resolveAnthropicModelTraits(modelName);

    switch (traits.thinkingShape) {
        case 'adaptive':
            // `effort` is the SDK-level key; @ai-sdk/anthropic renders it as
            // `output_config.effort` on the wire. Passing `output_config`
            // ourselves would be silently stripped by the provider's schema.
            return {
                anthropic: { thinking: { type: 'adaptive' }, effort },
            };

        case 'budget':
            return {
                anthropic: {
                    thinking: {
                        type: 'enabled',
                        budgetTokens: EFFORT_TO_BUDGET[effort],
                    },
                },
            };

        default:
            logger.warn({
                message:
                    '[thinking] unrecognized Anthropic model — thinking config omitted',
                context: 'buildAnthropicReasoning',
                metadata: { modelName, effort },
            });
            return {};
    }
}

/**
 * Express "thinking off" for Anthropic. On Opus 5, Sonnet 5 and Fable 5
 * thinking is on by default, so omitting the config is not the same as
 * disabling it — the user picks Off and still pays for thinking.
 *
 * Fable/Mythos reject `disabled` outright (400), so there the only honest
 * answer is to leave thinking on.
 */
function buildAnthropicThinkingOff(modelName?: string): Record<string, any> {
    const traits = resolveAnthropicModelTraits(modelName);

    if (traits.thinkingShape === 'adaptive' && traits.canDisableThinking) {
        return { anthropic: { thinking: { type: 'disabled' } } };
    }

    // Legacy models don't think unless asked, and unidentified models get no
    // config at all — omitting is already "off" for both.
    return {};
}
