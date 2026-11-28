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
import { envManagedReasoningDescriptor } from '@libs/llm/managed-slot';
import {
    anthropicDeclaredMaxTokens,
    bedrockDeclaredMaxTokens,
    budgetAddedToAnswerCap,
    optionsNamespace,
} from '@libs/llm/answer-cap-budget';
import {
    resolveSlotCallOptions,
    type SlotCallOptions,
} from '@libs/llm/slot-call-options';
import {
    buildProviderOptions,
    defaultReasoningEffortFor,
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

export interface ResolveModelInvocationOptions extends ResolveAgentModelOptions {
    /** Names the reasoning-options log line + telemetry (usually the agent/functionId). */
    runName: string;
    /** Model-build options forwarded to the builder — notably `structuredOutputs`. */
    modelOptions?: ByokModelOptions;
    /** Force reasoning OFF for this call (effort 'none', override dropped). Set by
     *  the structured executor when `planStructuredCall` → 'suppress-thinking' — a
     *  disable-able model that would otherwise 400 on a forced tool_choice while
     *  thinking. The per-model decision lives in the plan (providers own the
     *  traits); this primitive just obeys the flag. */
    suppressReasoning?: boolean;
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
export function resolveModelConfig(
    slot: NormalizedModel | undefined,
    opts: ResolveModelInvocationOptions,
): ModelInvocation {
    const {
        runName,
        modelOptions,
        suppressReasoning,
        // The standard fallback effort lives HERE, not at each call-site — a
        // consumer only passes it to deviate (e.g. 'none' to disable).
        reasoningEffortDefault = 'low',
        telemetryMetadata,
        openrouterProviderOrder,
        openrouterAllowFallbacks,
        ...agentModelOptions
    } = opts;

    const resolvedSlot = slot ?? undefined;

    // The env/managed path routes an `undefined` slot, so the provider lives in
    // the env config, not the slot. Resolve it ONCE here (only when there's no
    // BYOK slot) and reuse it for both the model build and the reasoning default —
    // so a failing env-LLM (e.g. a suspended Moonshot/Kimi key) reports its REAL
    // provider in the byok-error notification instead of "unknown".
    const envDescriptor = resolvedSlot
        ? undefined
        : envManagedReasoningDescriptor();

    const model = resolveAgentModel(resolvedSlot, {
        ...agentModelOptions,
        provider:
            agentModelOptions.provider ??
            resolvedSlot?.provider ??
            envDescriptor?.provider,
        modelOptions,
    });

    const { providerOptions } = resolveReasoningOptions(
        resolvedSlot,
        envDescriptor,
        {
            runName,
            suppressReasoning,
            reasoningEffortDefault,
            telemetryMetadata,
            openrouterProviderOrder,
            openrouterAllowFallbacks,
        },
    );

    return {
        model,
        // `defaultModelOverride` (in agentModelOptions) already reached the model
        // build via resolveAgentModel; honor it here too so the env/managed-default
        // NAME matches the model actually built (no slot → the override wins).
        modelName: getModelName(
            resolvedSlot,
            agentModelOptions.defaultModelOverride,
        ),
        // For the env/managed path, resolvedSlot is undefined and the provider
        // lives in envDescriptor. Pass it as a fallback so anthropic-wire env
        // providers (API_LLM_PROVIDER=anthropic_compatible/moonshot/zai) get
        // the same large-default injection that BYOK slots on those transports do.
        // Strip temperature from the env-descriptor result: the descriptor carries
        // no user-configured temperature and resolveByokTemperature's fixed-policy
        // branch would otherwise inject a provider-pinned value on every env call.
        callOptions: (() => {
            const opts = resolveSlotCallOptions(
                resolvedSlot ??
                    (envDescriptor as unknown as Parameters<typeof resolveSlotCallOptions>[0]),
            );
            if (!resolvedSlot) {
                delete (opts as Record<string, unknown>).temperature;
            }
            return opts;
        })(),
        providerOptions,
    };
}

/**
 * The reasoning `providerOptions` a call on this slot carries: the slot's own
 * effort or override, else the env's, else the family default, else the
 * caller's. Pure (no model build), so a caller can learn what will be sent
 * before sending it.
 */
function resolveReasoningOptions(
    resolvedSlot: NormalizedModel | undefined,
    envDescriptor: ReturnType<typeof envManagedReasoningDescriptor>,
    opts: Pick<
        ResolveModelInvocationOptions,
        | 'runName'
        | 'suppressReasoning'
        | 'telemetryMetadata'
        | 'openrouterProviderOrder'
        | 'openrouterAllowFallbacks'
    > & { reasoningEffortDefault: ReasoningEffort },
): {
    providerOptions: Record<string, any>;
    reasoningSlot: { provider: string; model: string } | undefined;
} {
    const {
        runName,
        suppressReasoning,
        reasoningEffortDefault,
        telemetryMetadata,
        openrouterProviderOrder,
        openrouterAllowFallbacks,
    } = opts;
    // The env/managed path routes an `undefined` slot (no BYOK), so its provider +
    // model live in the env config, NOT the slot. Recover them for the reasoning
    // computation ONLY — so an env-configured reasoner (Opus/Kimi/GLM) gets the
    // SAME family-default thinking a connected BYOK slot of that model would. The
    // model BUILD flows through resolveAgentModel in resolveModelConfig (it reads the env
    // itself); this descriptor only feeds the reasoning-effort default and the
    // provider-options namespace. A real BYOK slot always wins over it.
    const reasoningSlot:
        NormalizedModel | { provider: string; model: string } | undefined =
        resolvedSlot ?? envDescriptor;

    // `suppressReasoning` forces reasoning OFF (effort 'none', override dropped) —
    // the structured executor sets it when its `planStructuredCall` returns
    // 'suppress-thinking' (a disable-able model that would otherwise 400 with a
    // forced tool_choice + thinking). The WHOLE per-model decision lives in that
    // plan (providers own the traits); this primitive stays provider-agnostic and
    // only obeys the boolean. Agent loops and 'as-is'/'reroute-json' plans never
    // set it, so their reasoning is untouched.
    const effectiveReasoningEffort: ReasoningEffort = suppressReasoning
        ? 'none'
        : (resolvedSlot?.reasoningEffort ??
          // API_LLM_REASONING_EFFORT: the env's equivalent of the slot's own.
          envDescriptor?.reasoningEffort ??
          // Family default from the provider's own reasoningTraits (thinks-by-
          // default → 'medium'), applied to BOTH env and BYOK slots. Replaces the
          // dead per-model catalog default; the slot's explicit effort still wins,
          // and a non-reasoning model falls through to the caller's own default.
          defaultReasoningEffortFor(
              reasoningSlot as NormalizedModel | undefined,
          ) ??
          reasoningEffortDefault);

    const providerOptions = buildProviderOptions(runName, telemetryMetadata, {
        reasoningEffort: effectiveReasoningEffort,
        reasoningConfigOverride: suppressReasoning
            ? undefined
            : resolvedSlot?.reasoningConfigOverride,
        byokProvider: reasoningSlot?.provider,
        modelName: reasoningSlot?.model,
        openrouterProviderOrder,
        openrouterAllowFallbacks,
    });

    return { providerOptions, reasoningSlot };
}

/** How a call resolves reasoning: an agent loop's, or a structured call's. */
export interface AnswerCallReasoning {
    /** The effort an unset slot gets: `low` in an agent loop, `none` structured. */
    reasoningEffortDefault?: ReasoningEffort;
    /** The call turns thinking off (a structured call's `suppress-thinking` plan). */
    suppressReasoning?: boolean;
    /**
     * The reasoning options the call sends, when its caller builds them
     * itself (the review's finder and verify pass their own): used as they
     * are, instead of resolving them from the slot.
     */
    providerOptions?: Record<string, unknown>;
}

/** What @ai-sdk/amazon-bedrock adds when thinking is on and no answer is set. */
const BEDROCK_UNSET_ANSWER_ROOM = 4096;

/**
 * The answer a call on this slot (or, without one, on the env-managed model)
 * declares to the provider for `answerTokens`: Anthropic and Bedrock ask for
 * `max_tokens = answer + thinking budget`, and Anthropic caps that sum at a
 * known Claude model's output limit. With `answerTokens` unset, what the
 * provider is sent when the slot sets no limit: Anthropic's adapter still
 * declares the model's whole output limit, so the window must hold it.
 * Undefined only when nothing is declared (the provider decides).
 * Reasoning resolves as an agent loop's unless `call` says otherwise.
 */
export async function declaredAnswerTokens(
    slot: NormalizedModel | undefined,
    answerTokens: number,
    call?: AnswerCallReasoning,
): Promise<number>;
export async function declaredAnswerTokens(
    slot: NormalizedModel | undefined,
    answerTokens: number | undefined,
    call?: AnswerCallReasoning,
): Promise<number | undefined>;
export async function declaredAnswerTokens(
    slot: NormalizedModel | undefined,
    answerTokens: number | undefined,
    call: AnswerCallReasoning = {},
): Promise<number | undefined> {
    try {
        const resolved = resolveReasoningOptions(
            slot,
            slot ? undefined : envManagedReasoningDescriptor(),
            {
                runName: 'declaredAnswerTokens',
                reasoningEffortDefault: call.reasoningEffortDefault ?? 'low',
                suppressReasoning: call.suppressReasoning,
            },
        );
        const reasoningSlot = resolved.reasoningSlot;
        const providerOptions =
            call.providerOptions ?? resolved.providerOptions;
        const namespace = optionsNamespace(reasoningSlot);
        if (namespace === 'amazonBedrock' && reasoningSlot?.model) {
            const declared = await bedrockDeclaredMaxTokens(
                reasoningSlot.model,
                answerTokens,
                providerOptions,
            );
            if (declared?.maxTokens !== undefined) {
                return declared.maxTokens;
            }
            if (declared && answerTokens === undefined) {
                // Nothing in the body: AWS applies the model's maximum
                // output. A Claude model's is the one Anthropic's adapter
                // knows; for another model it is not known here.
                return /claude/i.test(reasoningSlot.model)
                    ? await anthropicDeclaredMaxTokens(
                          reasoningSlot.model,
                          undefined,
                          undefined,
                      )
                    : undefined;
            }
        }
        if (namespace === 'anthropic' && reasoningSlot?.model) {
            const declared = await anthropicDeclaredMaxTokens(
                reasoningSlot.model,
                answerTokens,
                providerOptions,
            );
            if (declared !== undefined) {
                return declared;
            }
        }
        const budget = budgetAddedToAnswerCap(
            providerOptions,
            reasoningSlot,
            namespace,
        );
        if (answerTokens === undefined) {
            return budget === undefined
                ? undefined
                : budget + BEDROCK_UNSET_ANSWER_ROOM;
        }
        return answerTokens + (budget ?? 0);
    } catch {
        return answerTokens;
    }
}
