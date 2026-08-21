/**
 * Structured single-shot LLM call for the review pipeline, on the LOCAL
 * (Vercel AI SDK) stack — no legacy PromptRunnerService.
 *
 * Model policy (1 model per task — no runtime error-recovery fallback):
 *   - the run resolves ONE model: the org's BYOK model, or our managed default
 *     when no BYOK (`accounts/fireworks/models/deepseek-v4-flash` on Fireworks —
 *     resolved by buildModelFromSlot).
 *
 * There is NO 2nd-model cascade: no managed Groq for trial orgs, no
 * `byok-fallback` for BYOK orgs. A model failure/timeout fails the call. The
 * only retry is the D-00c latency guard below — ONE re-issue of the SAME model
 * on a transient (5xx/network) blip; it never touches a 2nd model.
 * (Reliability caveat accepted 2026-07-29; resilience is re-addressed in Phase 5.)
 */
import { Output, type LanguageModel, type Schema } from 'ai';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { z } from 'zod';
import {
    getLimiterForSlot,
    mayUseJsonSchema,
    markJsonSchemaUnsupported,
    isJsonSchemaUnsupportedError,
    type ByokModelOptions,
} from '@libs/llm/byok-to-vercel';
import { resolveModelConfig } from '@libs/llm/model-invocation';
import { agentModelIdentity } from '@libs/llm/model-identity';
import {
    tracedGenerateText,
    timeoutSignal,
    LLM_CALL_TIMEOUT_MS,
} from '@libs/llm/llm-call';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { zodToStrictWireSchema } from '@libs/llm/strict-wire-schema';
import {
    classifyLLMError,
    isAbortOrHardTimeout,
} from '@libs/llm/error-classifier';
import {
    RETRYABLE_CATEGORY,
    jitteredBackoffMs,
    sleep,
} from '@libs/llm/retry-policy';
import { getLlmObservability } from '@libs/llm/llm-observability';

const logger = createLogger('StructuredReviewCall');

/** Fields shared by every review call (structured or plain-text). `byokConfig`
 *  is the bare resolved slot; `buildModelFromSlot`/`getModelName` take it directly. */
export interface BaseReviewCallParams {
    byokConfig?: NormalizedModel;
    /** System prompt. OPTIONAL — some one-shots (severity classification) put
     *  everything in `user` and send no system message; the SDK omits it. */
    system?: string;
    user: string;
    /** Used for the runName and (unless `spanName` is set) the span name. */
    runName: string;
    organizationId?: string;
    attrs?: Record<string, unknown>;
    /** Per-call hard-timeout budget (ms). Defaults to LLM_CALL_TIMEOUT_MS (10min).
     *  Secondary passes that must not hold a pipeline slot pass a shorter one. */
    timeoutMs?: number;
    /** Force a default model on the env/managed path (no BYOK slot) — the trial
     *  default (e.g. the PR summary's KODUS_TRIAL_MODEL). Ignored when a real slot
     *  resolves. Threaded to both `buildModelFromSlot` and the span's model name. */
    defaultModelOverride?: string;
    /** Langfuse span metadata (org / team / PR ...). Defaults to
     *  `{ organizationId }` when omitted — the structured callers' existing shape. */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** Observability span name; defaults to `runName`. */
    spanName?: string;
    /** Override the slot's sampling temperature — a fixed value the caller wants
     *  regardless of the slot (public/demo paths). Unset → the slot's callOptions. */
    temperature?: number;
    /** Override the slot's max-output cap. Unset → the slot's callOptions. */
    maxOutputTokens?: number;
    /** Override the slot-derived provider options (reasoning/thinking config) —
     *  e.g. a demo path forcing Gemini thinking off. Unset → the slot's own. */
    providerOptions?: Record<string, unknown>;
}

export interface StructuredReviewCallParams<
    S extends z.ZodType | Schema,
> extends BaseReviewCallParams {
    /** A zod schema, or an AI-SDK `jsonSchema()` Schema when the caller
     *  needs the wire JSON schema to differ from the parse validation
     *  (e.g. OpenAI-strict `required` semantics vs lenient providers). */
    schema: S;
}

/** A plain-text review call — same model policy + reasoning + limiter + span +
 *  D-00c retry as the structured path, but no schema: returns the raw string. */
export type TextReviewCallParams = BaseReviewCallParams;

/** Per-output-mode knobs the shared core is parameterized on. */
interface ReviewCallMode<T> {
    /** Model-build options — structured opts the OpenAI-compatible branch into
     *  json_schema response_format; text passes none. */
    modelOptions: ByokModelOptions;
    /** Extra generateText args for the mode (the `output` object, or nothing). */
    outputArgs: Record<string, unknown>;
    /** Pull the caller-facing result from the SDK response. */
    extract: (r: any) => T;
}

/**
 * The ONE review-call executor: resolves the SINGLE review model (BYOK or the
 * managed default), honors the slot's tuning + reasoning + limiter, runs it in an
 * observability span, and owns the single cooldown-aware D-00c latency re-issue.
 * `mode` is the only thing that differs between structured and text output — so
 * both public entry points share this exact model policy and retry contract.
 */
async function runReviewCall<T>(
    params: BaseReviewCallParams,
    mode: ReviewCallMode<T>,
): Promise<T> {
    const {
        byokConfig,
        system,
        user,
        runName,
        organizationId,
        attrs,
        timeoutMs,
        defaultModelOverride,
        telemetryMetadata,
        spanName,
        temperature: temperatureOverride,
        maxOutputTokens: maxOutputTokensOverride,
        providerOptions: providerOptionsOverride,
    } = params;

    const mainSlot = byokConfig;

    // ONE montagem — the SAME `resolveModelConfig` every other consumer uses,
    // not a 2nd hand-rolled copy. It builds the model (BYOK slot or managed
    // default), wraps it in the BYOK limiter + failure reporter, and derives
    // callOptions + providerOptions + modelName from the shared primitives. The
    // executor now only *executes* the assembled invocation.
    //
    // `reasoningEffortDefault: 'none'` preserves the review policy: an UNSET slot
    // adds NO reasoning (resolveModelConfig otherwise defaults to 'low'). The
    // slot's own effort/override still win. OpenRouter pins ride the slot through.
    // Telemetry metadata is intentionally NOT forwarded here (providerOptions is
    // grouping-agnostic; the span's telemetry is built in `call` below). Computed
    // once — the same model + reasoning is reused by the D-00c re-issue below.
    // Structured mode may send `response_format: json_schema`. Some providers
    // advertise support but reject it at runtime (Gemini / some proxies) — build
    // a helper so the same invocation can be re-issued with json_schema OFF, and
    // skip json_schema up front for a slot already proven to reject it.
    const structuredMode = mode.modelOptions.structuredOutputs === true;
    const buildInvocation = (structuredOutputs: boolean) =>
        resolveModelConfig(mainSlot, {
            runName,
            // Only the structured path toggles the flag; text keeps its own
            // modelOptions untouched (asserted: text sends no structured arg).
            modelOptions: structuredMode
                ? { ...mode.modelOptions, structuredOutputs }
                : mode.modelOptions,
            defaultModelOverride,
            organizationId,
            reasoningEffortDefault: 'none',
            openrouterProviderOrder: (mainSlot as any)?.openrouterProviderOrder,
            openrouterAllowFallbacks: (mainSlot as any)?.openrouterAllowFallbacks,
        });

    const sentJsonSchema = structuredMode && mayUseJsonSchema(mainSlot);
    const {
        model: mainModel,
        modelName: mainModelName,
        callOptions,
        providerOptions,
    } = buildInvocation(sentJsonSchema);

    // No 2nd-model cascade: every attempt is the same resolved model. Tag
    // BYOK-vs-system so deriveTu attributes the spend correctly (resolved main
    // slot = the org's own key; no slot = managed/env default) — derived from
    // slot presence, never key material. `fallback` defaults false but a caller
    // may set attrs.fallback to mark its OWN retry (kody-rules raw-JSON re-issue).
    // ONE usage identity for the span — derived from the resolved slot, so every
    // caller's cost span carries the billing keys (byokModelId / credentialId)
    // that only the dedup pass used to record by hand. Caller context
    // (organizationId + attrs.prNumber/…) rides the attrs, applied at span start.
    const identity = agentModelIdentity(mainSlot);
    const spanAttrs = {
        ...(attrs ?? {}),
        fallback: (attrs?.fallback as boolean | undefined) ?? false,
        type:
            (attrs?.type as string | undefined) ??
            (mainSlot ? 'byok' : 'system'),
        ...(organizationId ? { organizationId } : {}),
    };

    const call = (model: LanguageModel, modelName: string): Promise<T> => {
        const exec = () =>
            tracedGenerateText({
                model: model as any,
                system,
                prompt: user,
                // Output mode: structured spreads `output: Output.object`, text
                // spreads nothing (plain generateText → r.text).
                ...mode.outputArgs,
                // Per-model tuning (temperature / max-output) from the ONE
                // montagem above — the review path can't silently drop it again.
                ...callOptions,
                // Caller overrides win over the slot's callOptions (fixed-tuning
                // demo paths); unset → the slot's own values above stand.
                ...(temperatureOverride != null
                    ? { temperature: temperatureOverride }
                    : {}),
                ...(maxOutputTokensOverride != null
                    ? { maxOutputTokens: maxOutputTokensOverride }
                    : {}),
                // Provider-specific reasoning/thinking + OpenRouter routing (the
                // other SDK channel; empty when the slot sets none). A caller
                // override (e.g. Gemini thinking off) replaces the slot-derived one.
                providerOptions: providerOptionsOverride ?? providerOptions,
                // Pin the AI SDK's OWN retry to 0 (ai@7 defaults to 2) so it can't
                // stack under the app-level D-00c re-issue and the wrapper catch.
                maxRetries: 0,
                // Cap hung provider calls at `timeoutMs` (default 10min) instead of
                // the 30min agent-level fallback; also feeds the BYOK limiter
                // cancellation. A secondary pass may pass a shorter budget.
                abortSignal: timeoutSignal(timeoutMs ?? LLM_CALL_TIMEOUT_MS),
                ...toAiSdkTelemetryArgs(
                    buildLangfuseTelemetry(
                        runName,
                        telemetryMetadata ?? { organizationId },
                    ),
                ),
            } as any);

        // Wrap the call in the app's observability span (reads usage from
        // result.usage). Resolved from the LLM observability PORT — the app
        // registers it once at bootstrap; a bare caller that never registered
        // one runs directly (still gets the limiter, reasoning, timeout and
        // retry — only the span is skipped).
        const observability = getLlmObservability();
        const run = observability
            ? observability.runAiSdkLLMInSpan<any>({
                  spanName: spanName ?? runName,
                  runName,
                  model: modelName,
                  // Billing keys from the ONE identity — parity with the old
                  // recordAgentRunUsage(agentModelIdentity(slot)) the dedup used.
                  byokModelId: identity.byokModelId,
                  credentialId: identity.credentialId,
                  // Routing task + fallback flag the slot carried down from
                  // resolveTaskSlot (route = the LlmTask, not the tier).
                  route: mainSlot?.route,
                  usedFallback: mainSlot?.usedFallback,
                  attrs: spanAttrs,
                  exec,
              })
            : exec();

        return run.then((r: any) => mode.extract(r));
    };

    try {
        return await call(mainModel, mainModelName);
    } catch (err) {
        // json_schema → json_object fallback. A structured provider that
        // advertised support but rejected the json_schema body at runtime
        // (Gemini / some proxies): cache the slot so future structured calls skip
        // json_schema, then re-issue ONCE with response_format=json_object. Fires
        // only when we actually sent json_schema — the error is definitionally
        // proof we did — so a json_object attempt never triggers a byte-identical
        // retry. Folds `withStructuredOutputFallback` into the ONE executor, so
        // every structured LLM.run caller gets this resilience, not just dedup.
        if (sentJsonSchema && isJsonSchemaUnsupportedError(err)) {
            markJsonSchemaUnsupported(mainSlot);
            const downgraded = buildInvocation(false);
            return await call(downgraded.model, downgraded.modelName);
        }

        // D-00c latency guard — the SINGLE app-level retry owner (the AI SDK's
        // own retry is pinned to 0 above; the wrapper catch only classifies +
        // arms cooldown, it never retries). Exactly ONE same-model re-issue,
        // bounded and cooldown-aware. This is NOT the removed model fallback: it
        // re-runs the SAME resolved model, once; a re-issue failure propagates
        // (no 2nd model — attrs.fallback stays false).
        const category = classifyLLMError(err).category;

        // Preserved verbatim (Phase 0 Pitfall 3): a genuinely aborted /
        // hard-timed-out call is NEVER re-issued — classifyLLMError lumps
        // AbortError / [HARD-TIMEOUT] into TRANSIENT, yet re-running a slow /
        // already-timed-out call just burns the whole 10-min budget again. The
        // re-issue reuses the same call() closure and its existing
        // timeoutSignal(LLM_CALL_TIMEOUT_MS)/hardTimeout chain — no fresh budget.
        if (isAbortOrHardTimeout(err)) {
            throw err;
        }

        // Cooldown-aware: after a classified RATE_LIMIT the wrapper armed the
        // slot's limiter with cooldownMs. Never re-issue into a cooling slot
        // (arm-then-honor) — an immediate re-fire would just hammer the
        // rate-limited provider. The caller backs off instead.
        if (
            getLimiterForSlot({
                slot: mainSlot,
                organizationId,
            })?.isInCooldown()
        ) {
            throw err;
        }

        // The ONE bounded same-model re-issue: a transient (5xx / network) blip.
        // A RATE_LIMIT (429) is NOT re-fired immediately — it backs off via the
        // limiter cooldown rather than an instant same-model retry. Full-jitter
        // backoff first (shared policy) so N parallel shards hitting the same blip
        // don't re-fire in lockstep — the thundering-herd the immediate re-issue
        // caused. One re-issue only; a re-issue failure still propagates.
        if (category === RETRYABLE_CATEGORY) {
            await sleep(jitteredBackoffMs(1));
            return await call(mainModel, mainModelName);
        }
        throw err;
    }
}

/**
 * Run a STRUCTURED-output call on the ONE resolved review model (BYOK or the
 * managed default). No 2nd-model fallback: a failure/timeout throws (bar the
 * single same-model latency-guard re-issue). Returns the parsed object validated
 * against `schema`.
 */
export async function runStructuredReviewCall<S extends z.ZodType | Schema>(
    params: StructuredReviewCallParams<S>,
): Promise<
    S extends z.ZodType ? z.infer<S> : S extends Schema<infer T> ? T : never
> {
    const { schema, runName, organizationId } = params;

    // A raw zod schema would go through the AI SDK's zodSchema(), whose
    // INPUT-side conversion drops `.optional()` fields from `required` —
    // OpenAI strict structured outputs 400 on that, which silently killed
    // kody-rules shards and guidance-file extraction for BYOK-OpenAI orgs.
    // Convert centrally so every caller (present and future) sends a
    // strict-compatible wire schema; AI-SDK Schema objects pass through
    // untouched (the caller already controls its wire format).
    let wireSchema: unknown = schema;
    if (schema instanceof z.ZodType) {
        try {
            wireSchema = zodToStrictWireSchema(schema);
        } catch (err) {
            // Unconvertible zod shape — fall back to the SDK's own
            // conversion rather than failing the call outright. That
            // fallback still 400s on OpenAI strict when the schema has
            // optional fields, so make the degradation loud: this is the
            // exact silence that hid the shard/extraction failures.
            logger.warn({
                message: `[strict-wire-schema] conversion failed for ${runName}; falling back to raw zod schema (OpenAI-strict callers may reject it): ${err instanceof Error ? err.message : String(err)}`,
                context: 'runStructuredReviewCall',
                metadata: { runName, organizationId, err },
            });
            wireSchema = schema;
        }
    }

    return runReviewCall(params, {
        modelOptions: { structuredOutputs: true },
        outputArgs: { output: Output.object({ schema: wireSchema as any }) },
        extract: (r) => (r.experimental_output ?? r.output) as any,
    });
}

/**
 * Run a PLAIN-TEXT call on the ONE resolved review model — same model policy,
 * reasoning, limiter, span and D-00c retry as the structured path, but no schema:
 * returns the raw generated string (e.g. the PR summary). This is the text half
 * of the single review executor, so a prose call can't drift back into a
 * hand-rolled `buildModelFromSlot` + telemetry copy.
 */
export async function runTextReviewCall(
    params: TextReviewCallParams,
): Promise<string> {
    return runReviewCall(params, {
        modelOptions: {},
        outputArgs: {},
        extract: (r) => (r.text ?? '') as string,
    });
}
