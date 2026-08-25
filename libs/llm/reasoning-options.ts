/**
 * Provider-specific reasoning/thinking `providerOptions` for a Vercel AI SDK
 * `generateText` call — domain-agnostic.
 *
 * Maps a normalized effort level ('none'|'low'|'medium'|'high') to each BYOK
 * provider's native thinking format, and layers OpenRouter provider-pinning on
 * top. No review/agent shapes — any caller building a model request can use it.
 */
import { BYOKProvider } from '@libs/llm/model-providers';
import { createLogger } from '@libs/core/log/logger';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import { REGISTRY } from '@libs/llm/providers';
import type { ProviderBuildConfig } from '@libs/llm/providers/kernel/types';

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
 * The Vercel AI SDK `providerOptions` namespace key for a BYOK provider id,
 * resolved from its provider module (the single source) — never a hand-kept map.
 */
function providerOptionsNamespace(provider?: BYOKProvider | string): string | undefined {
    if (!provider) return undefined;
    const id = String(provider);
    return REGISTRY.has(id)
        ? REGISTRY.get(id).providerOptionsNamespace?.(id)
        : undefined;
}

/** Keys that count as "already namespaced" at the top level of an override:
 *  every namespace the registry's modules declare, plus `langsmith` (a telemetry
 *  namespace, not a provider). Derived so a new provider is recognized for free. */
function knownNamespaceKeys(): Set<string> {
    const keys = new Set<string>(['langsmith']);
    for (const id of REGISTRY.ids()) {
        const ns = REGISTRY.get(id).providerOptionsNamespace?.(id);
        if (ns) keys.add(ns);
    }
    return keys;
}

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

    const known = knownNamespaceKeys();
    const alreadyNamespaced = keys.some((k) => known.has(k));
    if (alreadyNamespaced) return obj;

    const ns = providerOptionsNamespace(provider);
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
 *   - Anthropic: per model generation — see `providers/anthropic/traits.ts`
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

    // The provider module's reasoning() is the SINGLE source for the effort→
    // native mapping — including "off": Anthropic must say `disabled` out loud on
    // models that think by default, and only its own module knows that. Generic
    // code stays provider-agnostic: one uniform call for every effort, no
    // per-provider branch. An unknown / reasoning-less provider (novita, bedrock)
    // yields {}.
    const id = String(provider);
    if (!REGISTRY.has(id)) return {};
    const providerModule = REGISTRY.get(id);
    if (!providerModule.reasoning) return {};
    return providerModule.reasoning(
        { provider: id, model: modelName ?? '', apiKey: '' } as ProviderBuildConfig,
        effort ?? 'none',
    );
}

/**
 * Whether a STRUCTURED-output call on this provider/model uses forced tool_choice
 * (the Anthropic protocol), which the API rejects when thinking is enabled. The
 * model-assembly layer consults this to suppress reasoning on structured calls so
 * `tool_choice: 'required'` stays valid. Provider-agnostic: one registry lookup,
 * the module answers per its own protocol (native Anthropic + Kimi/GLM = true;
 * Bedrock/Vertex only for Claude ids; OpenAI/Gemini/others = false). Unknown /
 * reasoning-less provider ⇒ false.
 */
export function structuredOutputForcesToolChoice(
    provider?: BYOKProvider | string,
    modelName?: string,
): boolean {
    if (!provider) return false;
    const id = String(provider);
    if (!REGISTRY.has(id)) return false;
    const providerModule = REGISTRY.get(id);
    if (!providerModule.structuredOutputForcesToolChoice) return false;
    return providerModule.structuredOutputForcesToolChoice({
        provider: id,
        model: modelName ?? '',
        apiKey: '',
    } as ProviderBuildConfig);
}
