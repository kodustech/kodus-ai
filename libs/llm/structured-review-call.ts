/**
 * Structured single-shot LLM call for the review pipeline, on the LOCAL
 * (Vercel AI SDK) stack — no legacy PromptRunnerService.
 *
 * Model policy (1 model per task — no runtime error-recovery fallback):
 *   - the run resolves ONE model: the org's BYOK model, or our managed default
 *     when no BYOK (`kimi-k2.7-code` via Moonshot — resolved by byokToVercelModel).
 *
 * There is NO 2nd-model cascade: no managed Groq for trial orgs, no
 * `byok-fallback` for BYOK orgs. A model failure/timeout fails the call. The
 * only retry is the D-00c latency guard below — ONE re-issue of the SAME model
 * on a transient (5xx/network) blip; it never touches a 2nd model.
 * (Reliability caveat accepted 2026-07-29; resilience is re-addressed in Phase 5.)
 */
import { Output, type LanguageModel, type Schema } from 'ai';
import type { BYOKConfig } from '@libs/llm/byok-config';
import { z } from 'zod';
import {
    buildModelFromSlot,
    getModelName,
    getLimiterForSlot,
} from '@libs/llm/byok-to-vercel';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';
import {
    tracedGenerateText,
    timeoutSignal,
    LLM_CALL_TIMEOUT_MS,
} from '@libs/llm/llm-call';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { zodToStrictWireSchema } from '@libs/llm/strict-wire-schema';
import {
    classifyLLMError,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';
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

export interface StructuredReviewCallParams<S extends z.ZodType | Schema> {
    byokConfig?: BYOKConfig;
    /** A zod schema, or an AI-SDK `jsonSchema()` Schema when the caller
     *  needs the wire JSON schema to differ from the parse validation
     *  (e.g. OpenAI-strict `required` semantics vs lenient providers). */
    schema: S;
    system: string;
    user: string;
    /** Used for both the observability span and its runName. */
    runName: string;
    organizationId?: string;
    attrs?: Record<string, unknown>;
    observabilityService: ObservabilityService;
}

/**
 * Run a structured-output call on the ONE resolved review model (BYOK or the
 * managed default). No 2nd-model fallback: a failure/timeout throws (bar the
 * single same-model latency-guard re-issue). Returns the parsed object validated
 * against `schema`.
 */
export async function runStructuredReviewCall<S extends z.ZodType | Schema>(
    params: StructuredReviewCallParams<S>,
): Promise<S extends z.ZodType ? z.infer<S> : S extends Schema<infer T> ? T : never> {
    const {
        byokConfig,
        schema,
        system,
        user,
        runName,
        organizationId,
        attrs,
        observabilityService,
    } = params;

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

    // The carrier's resolved main slot is read ONCE at THIS consumer boundary;
    // the builder (`buildModelFromSlot`) and `getModelName` take that single slot
    // and never read `.main`/`.fallback`. The `{main}` carrier itself is
    // dismantled in a later cleanup wave (Pass B).
    const mainSlot = byokConfig?.main;
    const mainModel = wrapByokModel(
        buildModelFromSlot(mainSlot, { structuredOutputs: true }),
        { byokConfig, organizationId, role: 'main' },
    );
    const mainModelName = getModelName(mainSlot);

    const call = (model: LanguageModel, modelName: string): Promise<any> =>
        observabilityService
            .runAiSdkLLMInSpan<any>({
                spanName: runName,
                runName,
                model: modelName,
                // No 2nd-model cascade: every attempt is the same resolved model.
                // Tag BYOK-vs-system so deriveTu attributes the spend correctly
                // (a resolved main slot = the org's own key; no slot = managed/env
                // default). Derived from slot presence, never from key material.
                attrs: {
                    ...(attrs ?? {}),
                    fallback: false,
                    type:
                        (attrs?.type as string | undefined) ??
                        (mainSlot ? 'byok' : 'system'),
                },
                exec: () =>
                    tracedGenerateText({
                        model: model as any,
                        system,
                        prompt: user,
                        output: Output.object({ schema: wireSchema as any }),
                        // Pin the AI SDK's OWN retry to 0 (default is 2 in
                        // ai@7 — verified against node_modules/ai). Without this
                        // the SDK silently retries UNDER the app-level D-00c
                        // re-issue AND the wrapper catch — three retry layers
                        // stacking (RESEARCH Pitfall 1) that can multiply the
                        // 10-min timeout budget. Collapsing them to the single
                        // cooldown-aware D-00c owner below is the whole point.
                        maxRetries: 0,
                        // Cap hung provider calls at LLM_CALL_TIMEOUT_MS (10min)
                        // instead of the 30min agent-level fallback — these run
                        // in parallel shards, so a stuck call must not hold a
                        // pipeline slot for the full agent budget. Also feeds the
                        // BYOK limiter cancellation. Matches peer AI-SDK callers.
                        abortSignal: timeoutSignal(LLM_CALL_TIMEOUT_MS),
                        ...toAiSdkTelemetryArgs(
                            buildLangfuseTelemetry(runName, {
                                organizationId,
                            }),
                        ),
                    } as any),
            })
            .then(
                (r: any) =>
                    (r.experimental_output ?? r.output) as any,
            );

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
        if (getLimiterForSlot({ slot: mainSlot, organizationId })?.isInCooldown()) {
            throw err;
        }

        // The ONE bounded same-model re-issue: a transient (5xx / network) blip.
        // A RATE_LIMIT (429) is NOT re-fired immediately — it backs off via the
        // limiter cooldown rather than an instant same-model retry.
        if (category === LlmErrorCategory.TRANSIENT) {
            return await call(mainModel, mainModelName);
        }
        throw err;
    }
}
