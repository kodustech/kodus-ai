/**
 * Wrap a model so every generate goes through the BYOK concurrency limiter
 * (process-wide rate limit) AND reports BYOK failures (drives the
 * `byok.llm_errors_threshold` notification).
 *
 * Done at the MODEL level (AI SDK `wrapLanguageModel`) so any agent runner stays
 * model-agnostic — the failure reporter is injected directly (no AsyncLocalStorage).
 */
import { wrapLanguageModel, type LanguageModel } from 'ai';

// The wrapped model and its generate-result type, derived FROM `wrapLanguageModel`
// so they track whichever AI SDK version is installed (no hand-imported V-suffixed
// names to drift). `WrappedModel` is `LanguageModelV*` — a subtype of the public
// `LanguageModel`, so callers are unaffected while `.doGenerate` stays visible.
type WrappedModel = ReturnType<typeof wrapLanguageModel>;
type ByokGenerateResult = Awaited<ReturnType<WrappedModel['doGenerate']>>;

import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    runWithBYOKLimiter,
    getLimiterForSlot,
} from '@libs/llm/byok-to-vercel';
import { estimateTextTokens } from '@libs/llm/token-estimate';
import {
    attachClassification,
    classifyLLMError,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';

/**
 * PRE-call token estimate for the tpm reservoir. Serializes the wire prompt the
 * same way the provider sees it, then counts with the SHARED tiktoken estimator
 * (`estimateTextTokens`) — NOT a char/4 heuristic (flat-4 under-counts dense
 * code ~1.6×). This is the ONE seam with `params.prompt`.
 */
function estimatePromptTokens(prompt: unknown): number {
    if (prompt == null) return 0;
    const text =
        typeof prompt === 'string' ? prompt : safeSerialize(prompt);
    return estimateTextTokens(text);
}

function safeSerialize(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return String(value);
    }
}

/**
 * POST-call real token total for reconcile. Reads `doGenerate().usage` — the
 * only seam with the actual usage — preferring `totalTokens`, falling back to
 * `inputTokens + outputTokens`. Returns undefined when usage is absent so the
 * reservoir leaves the pre-call estimate standing as the net debit.
 */
function extractUsageTotal(result: unknown): number | undefined {
    const usage = (result as { usage?: Record<string, unknown> } | null)
        ?.usage;
    if (!usage) return undefined;
    if (typeof usage.totalTokens === 'number') return usage.totalTokens;
    const input =
        typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    const output =
        typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    const sum = input + output;
    return sum > 0 ? sum : undefined;
}

export interface WrapByokModelOptions {
    byokConfig?: NormalizedModel;
    organizationId?: string;
    provider?: string;
    /** @deprecated No-op since 04b-02 — the limiter keys off the single resolved
     *  slot, not a `main`/`fallback`/`internal` role. Kept on
     *  the type so existing callers passing `role: 'main'` still compile; remove
     *  in a later cleanup wave. */
    role?: 'main' | 'fallback' | 'internal';
    queueTimeoutMs?: number;
    reporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
}

export function wrapByokModel(
    model: LanguageModel,
    opts: WrapByokModelOptions,
): WrappedModel {
    return wrapLanguageModel({
        model: model as any,
        middleware: {
            specificationVersion: 'v3',
            wrapGenerate: async ({ doGenerate, params }: any) => {
                const run = async () => {
                    try {
                        return await doGenerate();
                    } catch (err) {
                        // Classify (so downstream can read the canonical category)
                        // and report — never let the reporter mask the LLM error.
                        if (err && typeof err === 'object') {
                            const classified = classifyLLMError(
                                err,
                                opts.provider,
                            );
                            attachClassification(err, classified);

                            // Arm the slot's cooldown ONLY on a classified
                            // RATE_LIMIT (429-rate) when the slot opted in via
                            // cooldownMs. A QUOTA_EXCEEDED (429-billing) and a
                            // TRANSIENT (5xx/network) NEVER arm. Arming is a
                            // DELAY, not a retry: the limiter holds the next
                            // admission; the reporter and rethrow below are
                            // untouched. Reuses the classify already computed in
                            // this catch — no re-classification.
                            const cooldownSlot = opts.byokConfig;
                            const cooldownMs = cooldownSlot?.cooldownMs;
                            if (
                                classified.category ===
                                    LlmErrorCategory.RATE_LIMIT &&
                                !!cooldownMs &&
                                cooldownMs > 0
                            ) {
                                getLimiterForSlot({
                                    slot: cooldownSlot,
                                    organizationId: opts.organizationId,
                                })?.armCooldown(cooldownMs);
                            }
                        }
                        try {
                            opts.reporter?.({
                                organizationId: opts.organizationId,
                                provider: opts.provider ?? 'unknown',
                                errorMessage:
                                    err instanceof Error
                                        ? err.message
                                        : String(err ?? 'unknown'),
                            });
                        } catch {
                            /* reporter failures must not surface */
                        }
                        throw err;
                    }
                };

                // The limiter keys off the ONE resolved slot the org configured
                // for this task.
                const slot = opts.byokConfig;

                // tpm reservoir (hybrid): this wrapper is the ONE seam with BOTH
                // the pre-call prompt AND the post-call usage. Estimate the
                // prompt tokens to DEBIT the reservoir at admission, and hand the
                // usage extractor so the limiter RECONCILES estimate vs actual
                // after the call. Only when the slot carries tpm — otherwise zero
                // estimation overhead and the exact 05-01 path (rpm/concurrency).
                const hasTpm = !!slot?.tpm && slot.tpm > 0;
                const estimatedTokens = hasTpm
                    ? estimatePromptTokens(params?.prompt)
                    : undefined;

                // Pin T to the SDK's generate-result type so inference doesn't
                // collapse to `unknown` (the middleware return type would then
                // reject it). `run` yields exactly this, and `extractUsageTotal`
                // takes `unknown`, so nothing else constrains T.
                return runWithBYOKLimiter<ByokGenerateResult>(
                    {
                        slot,
                        organizationId: opts.organizationId,
                        abortSignal: params?.abortSignal,
                        queueTimeoutMs: opts.queueTimeoutMs,
                        estimatedTokens,
                        getUsageTokens: hasTpm ? extractUsageTotal : undefined,
                    },
                    run,
                    'llm-call',
                );
            },
        },
    });
}
