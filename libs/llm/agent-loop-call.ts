/**
 * The AGENT-LOOP half of `LLM.run` — a tool-driven, multi-step model call.
 *
 * `runReviewCall` (structured-review-call.ts) is the one-SHOT half: one prompt,
 * one response. This is the LOOP half: the AI SDK's `generateText` with `tools`
 * + `stopWhen` runs many steps (call tool → read result → decide → repeat) until
 * it answers or hits `maxSteps`. Both halves are reached through the SAME
 * `LLM.run`; the only difference is whether `loop` is present.
 *
 * The point of this file: the model concerns live HERE, once — never re-hand-rolled
 * by the agent runner. It owns exactly what the one-shot owns:
 *   - access   : slot → model (BYOK or managed) via `resolveModelConfig`
 *   - tuning   : temperature / maxOutputTokens from the slot's callOptions
 *   - reasoning: providerOptions from the slot
 *   - cache    : the prompt-cache breakpoints (system + latest user + last tool),
 *                a provider concern — applied here because we know the slot
 *   - repair   : `repairToolCall` re-issues against THIS model (never a system one)
 *   - tracing  : ONE observability span that records the run's usage (aggregate)
 *
 * The harness runner supplies only the LOOP seams (`tools`, `maxSteps`,
 * `stopWhen`/`prepareStep`/`onStepFinish` built from its policies) and the
 * messages — no model, no tuning, no span. It maps the returned result onto its
 * own RunState. This file never imports the harness (keeps the dependency arrow
 * agent-harness → @libs/llm; the seams are plain AI SDK shapes it forwards).
 */
import {
    generateText,
    stepCountIs,
    type LanguageModel,
    type ModelMessage,
} from 'ai';

import type { NormalizedModel } from '@libs/llm/byok-config';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import { agentModelIdentity } from '@libs/llm/model-identity';
import { applyCacheBreakpoints } from '@libs/llm/prompt-cache';
import { repairInvalidToolInput } from '@libs/llm/repair-tool-call';
import { getLlmObservability } from '@libs/llm/llm-observability';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';

/**
 * SDK-native per-step retry for the agentic loop. Some BYOK providers
 * (Neuralwatt/GLM, Synthetic, Z.AI) intermittently return empty response bodies
 * (output: null, usage.total: 0) — fast failures, so 3 retries (4 attempts)
 * survives them without extending the per-call timeout. Distinct from the
 * one-shot D-00c re-issue (that owns an error taxonomy the loop stays free of).
 */
const AGENT_STEP_MAX_RETRIES = 3;

/** The loop seams the harness runner builds from its policies. Forwarded VERBATIM
 *  to `generateText` — this file does not interpret them (no harness knowledge). */
export interface AgentLoopSeams {
    /** AI SDK tool map (already converted by the runner). */
    tools: Record<string, unknown>;
    /** Hard ceiling on steps — `stepCountIs(maxSteps)` is appended to stopWhen. */
    maxSteps: number;
    /** Extra stop conditions (policy `shouldStop`), OR-ed with the step ceiling. */
    stopWhen?: unknown[];
    /** Per-step directive hook (policy `prepareStep`) — returns the SDK shape
     *  ({ activeTools?, messages? }); the model is fixed for the whole run. */
    prepareStep?: (opts: any) => unknown;
    /** Per-step observation hook (policy `onStepFinish` + step collection). */
    onStepFinish?: (event: any) => unknown;
}

export interface AgentLoopParams {
    /** The resolved BYOK slot (or undefined → managed default). */
    byokConfig?: NormalizedModel;
    /** System prompt (cache-marked here when the provider honors inline markers). */
    system?: string;
    /** The conversation array the runner assembled. */
    messages: ModelMessage[];
    /** The loop seams from the runner's policies. */
    loop: AgentLoopSeams;
    /** Names the reasoning log + (unless spanName set) the observability span. */
    runName: string;
    /** Observability span name; defaults to runName. */
    spanName?: string;
    /** Cost-span attributes (agentName / phase / source / prNumber ...). */
    attrs?: Record<string, unknown>;
    organizationId?: string;
    /** BYOK failure reporter (byok-error-counter hook). Shape matches
     *  `resolveModelConfig`'s reporter so it threads through unchanged. */
    reporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
    /** Concurrency-limiter queue timeout (finder threads its own). */
    queueTimeoutMs?: number;
    /** Provider override for the limiter (defaults to the slot's provider). */
    provider?: string;
    /** Pre-built providerOptions (reasoning/thinking) that OVERRIDE the slot-
     *  derived ones. The review finder computes these from the review config
     *  (`buildProviderOptions(input.*)`), which can differ from the slot's own
     *  reasoning — this keeps that behavior byte-for-byte. Unset → LLM.run
     *  derives providerOptions from the slot. */
    providerOptions?: Record<string, unknown>;
    /** Langfuse observation metadata. */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** Cancellation / hard-timeout signal (the caller composes parent + timeout). */
    signal?: AbortSignal;
    /** Fallback max-output when the slot omits one (else provider default). */
    maxOutputTokens?: number;
    /** Override the slot's sampling temperature. */
    temperature?: number;
}

/**
 * Run the agent loop on the ONE resolved model. Returns the raw `generateText`
 * result (steps / usage / text) — the runner maps it onto RunState. Usage is
 * recorded ONCE here (the observability span), so no caller records it again.
 */
export async function runAgentLoopCall(
    params: AgentLoopParams,
): Promise<Awaited<ReturnType<typeof generateText>>> {
    const {
        byokConfig: slot,
        system,
        messages,
        loop,
        runName,
        spanName,
        attrs,
        organizationId,
        reporter,
        telemetryMetadata,
        signal,
    } = params;

    // ── access + tuning + reasoning: the SAME montagem the one-shot uses ──
    // `reasoningEffortDefault: 'none'` preserves the "honor the slot, no extra
    // default" policy (an unset slot adds no reasoning).
    const inv = resolveModelConfig(slot, {
        runName,
        organizationId,
        reporter,
        provider: params.provider,
        queueTimeoutMs: params.queueTimeoutMs,
        // Default reasoning effort matches what conversation / business / fetcher
        // used before this primitive (resolveModelConfig's own 'low' default).
        // The review finder never relies on it — it passes a providerOptions
        // override — so leaving the default here changes nothing for the finder.
        openrouterProviderOrder: (slot as any)?.openrouterProviderOrder,
        openrouterAllowFallbacks: (slot as any)?.openrouterAllowFallbacks,
    });
    const temperature = params.temperature ?? inv.callOptions.temperature;
    const maxOutputTokens =
        inv.callOptions.maxOutputTokens ?? params.maxOutputTokens;
    // Reasoning: a caller-supplied override wins (the finder's config-derived
    // providerOptions); otherwise the slot-derived ones.
    const providerOptions = params.providerOptions ?? inv.providerOptions;

    // ── prompt-cache breakpoints (provider concern; only a real multi-step loop
    // pays back the write premium). The helper asks the model's provider whether
    // it honors inline markers and stamps the three breakpoints when it does;
    // otherwise (implicit-cache/unknown providers, or a single-step call) the
    // inputs pass through untouched. Fall back to the built model for the no-slot
    // (managed / env default) path so a self-hosted Anthropic env default still
    // gets the hint (systemCacheControl keys its no-provider branch off the name).
    const { systemArg, callMessages, callTools } = applyCacheBreakpoints({
        system,
        messages,
        tools: loop.tools,
        maxSteps: loop.maxSteps,
        provider: slot?.provider,
        model: slot?.model ?? inv.model,
    });

    // ── ONE usage identity for the span — billing keys from the resolved slot ──
    const identity = agentModelIdentity(slot);
    const spanAttrs = {
        ...(attrs ?? {}),
        type: (attrs?.type as string | undefined) ?? (slot ? 'byok' : 'system'),
        ...(organizationId ? { organizationId } : {}),
    };

    const exec = () =>
        generateText({
            model: inv.model as any,
            maxRetries: AGENT_STEP_MAX_RETRIES,
            system: systemArg,
            messages: callMessages,
            tools: callTools as any,
            ...(temperature != null ? { temperature } : {}),
            ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
            providerOptions: providerOptions as any,
            abortSignal: signal,
            // Tool-call self-heal against THIS model (owned by LLM.run, not the
            // harness — it re-issues against the resolved BYOK model).
            repairToolCall: ((opts: {
                toolCall: { toolName: string; input: unknown };
                inputSchema: (o: { toolName: string }) => PromiseLike<unknown>;
                error: unknown;
            }) =>
                repairInvalidToolInput({
                    model: inv.model,
                    abortSignal: signal,
                    toolCall: opts.toolCall,
                    inputSchema: opts.inputSchema,
                    error: opts.error,
                })) as any,
            // Loop seams from the runner's policies — forwarded verbatim, plus the
            // hard step ceiling the harness always wants.
            stopWhen: [...((loop.stopWhen as any[]) ?? []), stepCountIs(loop.maxSteps)],
            ...(loop.prepareStep ? { prepareStep: loop.prepareStep as any } : {}),
            ...(loop.onStepFinish ? { onStepFinish: loop.onStepFinish as any } : {}),
            ...(telemetryMetadata
                ? toAiSdkTelemetryArgs(
                      buildLangfuseTelemetry(runName, telemetryMetadata),
                  )
                : {}),
        } as any);

    // ── ONE observability span — records the run's aggregate usage. Absent port
    // (a bare unit test) runs directly, still gets the model/loop, just no span. ──
    const observability = getLlmObservability();
    return observability
        ? observability.runAiSdkLLMInSpan<any>({
              spanName: spanName ?? runName,
              runName,
              model: inv.modelName,
              byokModelId: identity.byokModelId,
              credentialId: identity.credentialId,
              // Routing task + fallback flag the slot carried down from
              // resolveTaskSlot (route = the LlmTask, not the tier).
              route: slot?.route,
              usedFallback: slot?.usedFallback,
              attrs: spanAttrs,
              exec,
          })
        : exec();
}

// Re-export so callers can build a fixed model handle if needed (parity with
// the one-shot path's exported types). The runner never resolves a model.
export type { LanguageModel };
