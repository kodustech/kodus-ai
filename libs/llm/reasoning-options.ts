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
import {
    NON_REASONING_TRAITS,
    resolveCompatibleReasoningTraits,
} from '@libs/llm/providers/kernel/reasoning-traits';
import type { NormalizedModel } from '@libs/llm/byok-config';

const logger = createLogger('ReasoningOptions');

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

// Re-exported from the kernel leaf so existing importers keep working; the
// value itself lives in ONE place now (kernel/effort-budget.ts).
export { EFFORT_TO_BUDGET } from '@libs/llm/providers/kernel/effort-budget';

/**
 * The DEFAULT reasoning effort for a model when its slot leaves `reasoningEffort`
 * unset — derived from the provider module's own `reasoningTraits`, so it is
 * FAMILY-driven (a new opus/sonnet/kimi inherits it with no code change) and
 * applied UNIFORMLY to both the env-managed and BYOK slot paths through the one
 * `resolveModelConfig` funnel. This is the tuning default that used to sit (dead)
 * in the model catalog — now it lives with the provider, exactly like
 * `temperaturePolicy`, and reaches BOTH config paths instead of just BYOK.
 *
 * Rule: a model that THINKS BY DEFAULT gets 'medium' unless the slot overrides;
 * models that don't (budget/opt-in reasoners, non-reasoning) stay unset so the
 * caller's own default (e.g. the review's 'none') decides. No per-model table.
 */
export function defaultReasoningEffortFor(
    slot: NormalizedModel | undefined,
): ReasoningEffort | undefined {
    const provider = slot?.provider as string | undefined;
    if (!provider || !slot?.model || !REGISTRY.has(provider)) return undefined;
    try {
        const module = REGISTRY.get(provider);
        const traits =
            module.reasoningTraits?.(slot as any) ?? NON_REASONING_TRAITS;
        if (!traits.thinksByDefault) return undefined;

        // `thinksByDefault` is a FACT; imposing a family default is a POLICY.
        // Reading one as the other is what made the fact unsafe to declare — a
        // provider whose omission is harmless (Gemini) could not state that it
        // reasons without us overriding its own default level.
        //
        // The policy needs exactly one answer: would omitting turn reasoning OFF?
        // That is NOT derivable — `reasoning(cfg,'none')` emitting nothing looks
        // neutral, but OpenAI defaults gpt-5.1's effort to `none`, so omitting
        // there disables. So the module DECLARES it, and an undeclared model
        // stays on the safe side (impose; costs tokens, never disables).
        return traits.omittingDisablesReasoning === false ? undefined : 'medium';
    } catch {
        // A lookup failure must never break the call — fall back to the caller's
        // own default (matches resolveStructuredPlan's best-effort posture).
        return undefined;
    }
}

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
                input?.modelName,
            );
            const routing = buildOpenRouterRouting({
                ...input,
                // A hand-written override IS a request for reasoning when it
                // names reasoning at all — gated the same way as the effort
                // path below.
                wantsReasoning:
                    JSON.stringify(parsed).includes('reasoning') &&
                    !!resolveCompatibleReasoningTraits(input?.modelName ?? '')
                        ?.thinksByDefault,
            });
            return {
                ...routing,
                ...override,
                // A plain spread REPLACES the routing's `openrouter` object
                // with the override's, so an override naming only `reasoning`
                // came out with no `provider` block at all — losing the very
                // `require_parameters` it needed, on the routing lottery this
                // exists to escape.
                //
                // The guard is what keeps this scoped: `buildOpenRouterRouting`
                // returns {} for every provider that is not OpenRouter, so
                // `routing.openrouter` is undefined and the spread above is the
                // whole answer — an Anthropic or Gemini override is untouched.
                //
                // An `openrouter.provider` block the user wrote themselves
                // still wins outright. Someone who pins their own routing has
                // already solved the problem, and the two production overrides
                // that do this set `require_parameters` by hand.
                ...(routing.openrouter && override.openrouter
                    ? {
                          openrouter: {
                              ...routing.openrouter,
                              ...override.openrouter,
                          },
                      }
                    : {}),
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
    const routing = buildOpenRouterRouting({
        ...input,
        // An effort above 'none' is a request for reasoning — but only a model
        // the table CONFIRMS reasons may have that request made binding, or
        // the routing has nowhere left to send it.
        wantsReasoning:
            !!input?.reasoningEffort &&
            input.reasoningEffort !== 'none' &&
            !!resolveCompatibleReasoningTraits(input?.modelName ?? '')
                ?.thinksByDefault,
    });
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
    /** The slot asked for reasoning AND the model is a confirmed reasoner. */
    wantsReasoning?: boolean;
}): Record<string, any> {
    if (!input || input.byokProvider !== BYOKProvider.OPEN_ROUTER) return {};

    const order = input.openrouterProviderOrder?.filter(
        (p) => typeof p === 'string' && p.trim().length > 0,
    );
    const hasOrder = !!order && order.length > 0;
    const hasFallbacksOverride =
        typeof input.openrouterAllowFallbacks === 'boolean';

    if (!hasOrder && !hasFallbacksOverride && !input.wantsReasoning) {
        return {};
    }

    const providerPayload: Record<string, any> = {};
    if (hasOrder) providerPayload.order = order;
    if (hasFallbacksOverride) {
        providerPayload.allow_fallbacks = input.openrouterAllowFallbacks;
    }
    // A reasoning effort the routing can silently discard is not a setting, it
    // is a coin flip — but forcing the point breaks the models that have no
    // reasoning-capable upstream at all, so it is gated.
    //
    // OpenRouter picks an upstream PER REQUEST, weighted by price, and the
    // parameters it routes on are `tools`, `response_format` and `verbosity`.
    // Reasoning is not among them, and the docs say what happens then: "the
    // request is still routed to that model and the parameter is ignored". No
    // error, no warning, a normal answer that simply did not think. Measured,
    // not inferred: the same z-ai/glm-5.2 request returned 135 reasoning
    // tokens on one call and 0 on the next, minutes apart.
    //
    // `require_parameters` turns that soft preference into a hard one. It is
    // sent ONLY for a model the family table confirms reasons, and that limit
    // is measured too — applied to every slot with an effort, a live run came
    // back with:
    //
    //     qwen/qwen3-coder — No endpoints found that can handle the requested
    //     parameters.
    //
    // Not a degraded answer: no answer. There is no reasoning-capable upstream
    // for that model, so the hard preference removed every candidate and the
    // review would have failed outright. A silently ignored parameter costs
    // the user a setting; a dead request costs them the review.
    //
    // Models that reason WITHOUT being declared (nemotron, grok and mimo all
    // did on the same run) stay on the soft preference. They lose the
    // guarantee; they never lose the call.
    //
    // https://openrouter.ai/docs/features/provider-routing
    if (input.wantsReasoning) {
        providerPayload.require_parameters = true;
    }
    return { openrouter: { provider: providerPayload } };
}

/**
 * The Vercel AI SDK `providerOptions` namespace key for a BYOK provider id,
 * resolved from its provider module (the single source) — never a hand-kept map.
 */
function providerOptionsNamespace(
    provider?: BYOKProvider | string,
    model?: string,
): string | undefined {
    if (!provider) return undefined;
    const id = String(provider);
    return REGISTRY.has(id)
        ? REGISTRY.get(id).providerOptionsNamespace?.(id, model)
        : undefined;
}

/** Keys that count as "already namespaced" at the top level of an override:
 *  every namespace the registry's modules declare, plus `langsmith` (a telemetry
 *  namespace, not a provider). Derived so a new provider is recognized for free.
 *  Model-less on purpose: this asks "is this key A namespace", not "is it THIS
 *  model's namespace", and every model-dependent answer (Vertex's `anthropic`)
 *  is already contributed by the module that owns it.
 *
 *  Aliases count too. Recognising a key is not the same question as choosing one:
 *  we wrap under the canonical namespace, but a paste that already carries a key
 *  the SDK reads must be left alone. Missing an alias is the worst outcome here —
 *  a CORRECT override gets wrapped a second time and disappears. */
function knownNamespaceKeys(): Set<string> {
    const keys = new Set<string>(['langsmith']);
    for (const id of REGISTRY.ids()) {
        const mod = REGISTRY.get(id);
        const ns = mod.providerOptionsNamespace?.(id);
        if (ns) keys.add(ns);
        for (const alias of mod.providerOptionsNamespaceAliases?.(id) ?? []) {
            keys.add(alias);
        }
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
    model?: string,
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

    const ns = providerOptionsNamespace(provider, model);
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
        {
            provider: id,
            model: modelName ?? '',
            apiKey: '',
        } as ProviderBuildConfig,
        effort ?? 'none',
    );
}
