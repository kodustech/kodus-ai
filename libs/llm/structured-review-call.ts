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
    buildModelFromSlot,
    getModelName,
    getLimiterForSlot,
    type ByokModelOptions,
} from '@libs/llm/byok-to-vercel';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';
import { resolveSlotCallOptions } from '@libs/llm/slot-call-options';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
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
import { classifyLLMError } from '@libs/llm/error-classifier';
import {
    RETRYABLE_CATEGORY,
    jitteredBackoffMs,
    sleep,
} from '@libs/llm/retry-policy';
import { ObservabilityService } from '@libs/core/log/observability.service';

const logger = createLogger('StructuredReviewCall');

/**
 * classifyLLMError folds AbortError AND `[HARD-TIMEOUT]`/timeout/aborted text
 * into LlmErrorCategory.TRANSIENT. The latency guard (D-00c) must NOT re-issue
 * those: re-issuing a genuinely slow / already-timed-out call just burns the
 * whole timeout budget again (Phase 0 Pitfall 3 — the failure mode is latency,
 * not fidelity). This explicit gate carves them back out of "transient".
 */
function isAbortOrHardTimeout(err: unknown): boolean {
    if (!err) return false;
    if ((err as { name?: string }).name === 'AbortError') return true;
    const text = err instanceof Error ? err.message : String(err ?? '');
    return /\[HARD-TIMEOUT\]|aborted|timed?\s*out|timeout/i.test(text);
}

/** Fields shared by every review call (structured or plain-text). `byokConfig`
 *  is the bare resolved slot; `buildModelFromSlot`/`getModelName` take it directly. */
export interface BaseReviewCallParams {
    byokConfig?: NormalizedModel;
    system: string;
    user: string;
    /** Used for the runName and (unless `spanName` is set) the span name. */
    runName: string;
    organizationId?: string;
    attrs?: Record<string, unknown>;
    /** Observability span wrapper. OPTIONAL: bare callers that never recorded a
     *  span (e.g. severity classification, reference detection) can omit it and
     *  still get the shared model policy (limiter, reasoning, timeout, retry) —
     *  the call just runs without a span, exactly as those consumers did before. */
    observabilityService?: ObservabilityService;
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
        observabilityService,
        timeoutMs,
        defaultModelOverride,
        telemetryMetadata,
        spanName,
    } = params;

    const mainSlot = byokConfig;
    const mainModel = wrapByokModel(
        buildModelFromSlot(mainSlot, mode.modelOptions, defaultModelOverride),
        { byokConfig, organizationId, role: 'main' },
    );
    const mainModelName = getModelName(mainSlot, defaultModelOverride);

    // Honor the slot's OWN reasoning (effort + JSON override) and OpenRouter
    // pinning through the SHARED provider mapping — the same one every other
    // consumer uses. Fixes the review path silently dropping a BYOK user's
    // configured `reasoningEffort`. Policy: the slot's effort wins; UNSET adds NO
    // reasoning (buildReasoningProviderOptions falls to 'none' → {} for providers
    // that don't think by default, explicit-off only where one does), so a slot
    // that never set reasoning behaves as before. Computed once — the same model
    // (and reasoning) is reused by the D-00c latency re-issue below.
    const providerOptions = buildProviderOptions(runName, undefined, {
        reasoningEffort: mainSlot?.reasoningEffort,
        reasoningConfigOverride: mainSlot?.reasoningConfigOverride,
        byokProvider: mainSlot?.provider,
        modelName: mainSlot?.model,
        openrouterProviderOrder: (mainSlot as any)?.openrouterProviderOrder,
        openrouterAllowFallbacks: (mainSlot as any)?.openrouterAllowFallbacks,
    });

    // No 2nd-model cascade: every attempt is the same resolved model. Tag
    // BYOK-vs-system so deriveTu attributes the spend correctly (resolved main
    // slot = the org's own key; no slot = managed/env default) — derived from
    // slot presence, never key material. `fallback` defaults false but a caller
    // may set attrs.fallback to mark its OWN retry (kody-rules raw-JSON re-issue).
    const spanAttrs = {
        ...(attrs ?? {}),
        fallback: (attrs?.fallback as boolean | undefined) ?? false,
        type:
            (attrs?.type as string | undefined) ??
            (mainSlot ? 'byok' : 'system'),
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
                // Honor the slot's per-model tuning (temperature / max-output)
                // through the SHARED mapping — the review path can't silently
                // drop it again.
                ...resolveSlotCallOptions(mainSlot),
                // Provider-specific reasoning/thinking + OpenRouter routing (the
                // other SDK channel; empty when the slot sets none).
                providerOptions,
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

        // With an observability service, wrap the call in its span (reads usage
        // from result.usage). Without one — a bare caller that never recorded a
        // span — run it directly; it still gets the limiter, reasoning, timeout
        // and retry, only the span is skipped.
        const run = observabilityService
            ? observabilityService.runAiSdkLLMInSpan<any>({
                  spanName: spanName ?? runName,
                  runName,
                  model: modelName,
                  attrs: spanAttrs,
                  exec,
              })
            : exec();

        return run.then((r: any) => mode.extract(r));
    };

    try {
        return await call(mainModel, mainModelName);
    } catch (err) {
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
