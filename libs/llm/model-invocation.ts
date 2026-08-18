/**
 * The ONE way every LLM consumer turns a resolved BYOK slot into a ready-to-call
 * model invocation — the composition point for the cross-cutting knobs that used
 * to be re-assembled (and drift) at every call site.
 *
 * A `NormalizedModel` slot in → the four things every generateText/agent call
 * needs out:
 *   - `model`           — built from the slot + wrapped in the BYOK limiter /
 *                         failure reporter (via `resolveAgentModel`).
 *   - `modelName`       — the human `provider:model` label for the telemetry span.
 *   - `callOptions`     — per-model tuning (`temperature` / `maxOutputTokens`)
 *                         from the SHARED `resolveSlotCallOptions` mapping.
 *   - `providerOptions` — provider-specific reasoning/thinking + OpenRouter
 *                         routing from the SHARED `buildProviderOptions` mapping.
 *
 * Why this exists: the conversation agent, the business-rules analyzer, the skill
 * fetcher and the review finder each hand-rolled this block. The copies drifted —
 * one dropped the slot's `temperature`, another dropped `reasoningConfigOverride`,
 * another read `slot.maxOutputTokens` without the "≤0 means default" guard. That
 * class of silent divergence is exactly what a single derivation removes: a new
 * agent (or a new provider) honors the slot's tuning + reasoning for free.
 *
 * Scope: SLOT-DERIVED config only. Deliberately NOT here — telemetry spans,
 * abort/timeout signals, retry policy and usage recording, which legitimately
 * differ between the one-shot structured path and the agentic loop. Consumers
 * still own those; they just stop re-deriving the model/tuning/reasoning wrong.
 */
import type { LanguageModel } from 'ai';

import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    resolveAgentModel,
    type ResolveAgentModelOptions,
} from '@libs/llm/agent-model';
import { getModelName, type ByokModelOptions } from '@libs/llm/byok-to-vercel';
import {
    resolveSlotCallOptions,
    type SlotCallOptions,
} from '@libs/llm/slot-call-options';
import {
    buildProviderOptions,
    type ReasoningEffort,
} from '@libs/llm/reasoning-options';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';

export interface ModelInvocation {
    /** Slot-built model, already wrapped in the BYOK limiter + failure reporter. */
    model: LanguageModel;
    /** `provider:model` label for the telemetry span (env/managed default when no slot). */
    modelName: string;
    /** Per-model tuning to spread into the SDK call (`temperature` / `maxOutputTokens`). */
    callOptions: SlotCallOptions;
    /** Provider-specific reasoning + OpenRouter routing to spread as `providerOptions`. */
    providerOptions: Record<string, unknown>;
}

export interface ResolveModelInvocationOptions
    extends ResolveAgentModelOptions {
    /** Names the reasoning-options log line + telemetry (usually the agent/functionId). */
    runName: string;
    /** Model-build options forwarded to the builder — notably `structuredOutputs`. */
    modelOptions?: ByokModelOptions;
    /** Effort tier applied when the slot itself leaves `reasoningEffort` unset.
     *  Defaults to `'low'` — the standard every agent used before this primitive
     *  existed. Pass `'none'` to opt a consumer out of default reasoning. */
    reasoningEffortDefault?: ReasoningEffort;
    /** Telemetry metadata threaded into `buildProviderOptions` (Langfuse grouping). */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** OpenRouter provider pinning — forwarded to reasoning options when set. */
    openrouterProviderOrder?: string[];
    openrouterAllowFallbacks?: boolean;
}

/**
 * Resolve a slot into the model + tuning + reasoning every LLM call needs, all
 * derived through the shared primitives. `reasoningConfigOverride`, the OpenRouter
 * pins and the slot's own `reasoningEffort` are all honored here — so a consumer
 * can never again forget one of them the way the hand-rolled copies did.
 *
 * An `undefined` slot resolves the env/managed default model and yields
 * empty tuning + reasoning (the provider's own defaults apply). Absence is
 * always `undefined` (one convention) — resolvers never hand back `null`.
 */
export function resolveModelInvocation(
    slot: NormalizedModel | undefined,
    opts: ResolveModelInvocationOptions,
): ModelInvocation {
    const {
        runName,
        modelOptions,
        // The standard fallback effort lives HERE, not at each call-site — a
        // consumer only passes it to deviate (e.g. 'none' to disable).
        reasoningEffortDefault = 'low',
        telemetryMetadata,
        openrouterProviderOrder,
        openrouterAllowFallbacks,
        ...agentModelOptions
    } = opts;

    const resolvedSlot = slot ?? undefined;

    const model = resolveAgentModel(resolvedSlot, {
        ...agentModelOptions,
        provider: agentModelOptions.provider ?? resolvedSlot?.provider,
        modelOptions,
    });

    const providerOptions = buildProviderOptions(runName, telemetryMetadata, {
        reasoningEffort: resolvedSlot?.reasoningEffort ?? reasoningEffortDefault,
        reasoningConfigOverride: resolvedSlot?.reasoningConfigOverride,
        byokProvider: resolvedSlot?.provider,
        modelName: resolvedSlot?.model,
        openrouterProviderOrder,
        openrouterAllowFallbacks,
    });

    return {
        model,
        // `defaultModelOverride` (in agentModelOptions) already reached the model
        // build via resolveAgentModel; honor it here too so the env/managed-default
        // NAME matches the model actually built (no slot → the override wins).
        modelName: getModelName(resolvedSlot, agentModelOptions.defaultModelOverride),
        callOptions: resolveSlotCallOptions(resolvedSlot),
        providerOptions,
    };
}
