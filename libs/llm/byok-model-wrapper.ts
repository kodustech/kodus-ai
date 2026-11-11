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
    readAiSdkUsageFromError,
    readProviderUsage,
} from '@libs/llm/ai-sdk-usage';
import { admitRequest, meterAdmitsRequests } from '@libs/llm/usage-meter';
import {
    attachClassification,
    classifyLLMError,
    LlmErrorCategory,
    type ClassifiedErrorInfo,
} from '@libs/llm/error-classifier';
import { extractProviderMessage } from '@libs/llm/review-error-diagnostics';
import { createLogger } from '@libs/core/log/logger';
import {
    MAX_REFUSAL_RETRIES,
    rejectedReasoning,
    rememberRefusal,
    withoutReasoningField,
    withoutRefusedFields,
    withReasoningOff,
} from '@libs/llm/rejected-reasoning-field';
import { REGISTRY } from '@libs/llm/providers/kernel/registry';

const logger = createLogger('ByokModelWrapper');

/** The provider-options key the slot's adapter reads, so an effort the call
 *  never carried can be added there when the upstream asks for it. */
function optionsNamespace(
    slot: NormalizedModel | undefined,
): string | undefined {
    if (!slot?.provider || !REGISTRY.has(slot.provider)) return undefined;
    return REGISTRY.get(slot.provider).providerOptionsNamespace?.(
        slot.provider,
        slot.model,
    );
}

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
        /** The provider's own sentence when it gave one, else `err.message`. */
        errorMessage: string;
        category?: LlmErrorCategory;
        httpStatus?: number;
        routingRefusal?: boolean;
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
            wrapGenerate: async ({ doGenerate, params, model: inner }: any) => {
                const slot = opts.byokConfig;
                const namespace = optionsNamespace(slot);
                // What is sent: the call's own params, or with the answer cap
                // a spend-capped run enforces (below).
                let callParams = params;
                const generate = async () => {
                    const sent = withoutRefusedFields(
                        callParams,
                        slot,
                        opts.organizationId,
                        Date.now(),
                        namespace,
                    );
                    const call = (p: any) =>
                        p === params ? doGenerate() : inner.doGenerate(p);
                    // A strict upstream refuses one unknown field per answer
                    // (Go's decoder stops at the first), so each reasoning field
                    // we added can cost one more ask, never more than that: a
                    // retry needs a field still present to remove, and the count
                    // is capped besides.
                    let attempt = sent;
                    for (let retries = 0; ; retries++) {
                        try {
                            return await call(attempt);
                        } catch (err) {
                            const refusal = rejectedReasoning(err);
                            const retry =
                                refusal && retries < MAX_REFUSAL_RETRIES
                                    ? refusal.off
                                        ? withReasoningOff(
                                              attempt,
                                              refusal.field,
                                              namespace,
                                          )
                                        : withoutReasoningField(
                                              attempt,
                                              refusal.field,
                                          )
                                    : undefined;
                            if (!refusal || !retry) throw err;
                            const { field, off, refusedType } = refusal;
                            rememberRefusal(
                                slot,
                                opts.organizationId,
                                field,
                                Date.now(),
                                off,
                                refusedType,
                            );
                            logger.warn({
                                message: off
                                    ? `Upstream refused \`${field}\` with tools; asking again with it off`
                                    : `Upstream refused \`${field}\`; asking again without it`,
                                context: 'ByokModelWrapper',
                                metadata: {
                                    field,
                                    provider: slot?.provider,
                                    baseURL: slot?.baseURL,
                                    model: slot?.model,
                                    organizationId: opts.organizationId,
                                },
                            });
                            attempt = retry;
                        }
                    }
                };
                const run = async () => {
                    try {
                        return await generate();
                    } catch (err) {
                        // Classify (so downstream can read the canonical category)
                        // and report — never let the reporter mask the LLM error.
                        let classified: ClassifiedErrorInfo | undefined;
                        if (err && typeof err === 'object') {
                            classified = classifyLLMError(err, opts.provider);
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
                                provider:
                                    opts.provider ??
                                    opts.byokConfig?.provider ??
                                    'unknown',
                                // For an AI SDK `APICallError` the message
                                // only restates the status ("Provider returned
                                // error"); the cause is in the body (#1871).
                                errorMessage:
                                    extractProviderMessage(err) ??
                                    (err instanceof Error
                                        ? err.message
                                        : String(err ?? 'unknown')),
                                category: classified?.category,
                                httpStatus: classified?.httpStatus,
                                routingRefusal: classified?.routingRefusal,
                            });
                        } catch {
                            /* reporter failures must not surface */
                        }
                        throw err;
                    }
                };

                // The limiter keys off the ONE resolved slot the org configured
                // for this task (`slot`, above).

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

                // A metered run with a spend cap admits the request before it
                // leaves, against the most it can cost: its prompt and tools,
                // and the answer cap it asks for (#2451).
                const admission = admitRequest(() => ({
                    inputTokens: estimatePromptTokens({
                        prompt: params?.prompt,
                        tools: params?.tools,
                    }),
                    maxOutputTokens: params?.maxOutputTokens,
                }));
                // The answer cap it was admitted at is sent, so the provider
                // cannot answer past what was reserved. Zero is no cap a
                // provider accepts.
                if (
                    (admission.maxOutputTokens ?? 0) > 0 &&
                    params?.maxOutputTokens == null
                ) {
                    callParams = {
                        ...params,
                        maxOutputTokens: admission.maxOutputTokens,
                    };
                }
                const settle = admission.settle;

                // Pin T to the SDK's generate-result type so inference doesn't
                // collapse to `unknown` (the middleware return type would then
                // reject it). `run` yields exactly this, and `extractUsageTotal`
                // takes `unknown`, so nothing else constrains T.
                let result: ByokGenerateResult;
                try {
                    result = await runWithBYOKLimiter<ByokGenerateResult>(
                        {
                            slot,
                            organizationId: opts.organizationId,
                            abortSignal: params?.abortSignal,
                            queueTimeoutMs: opts.queueTimeoutMs,
                            estimatedTokens,
                            getUsageTokens: hasTpm
                                ? extractUsageTotal
                                : undefined,
                        },
                        run,
                        'llm-call',
                    );
                } catch (err) {
                    // An error can still carry what the provider billed.
                    settle(readAiSdkUsageFromError(err)?.usage);
                    throw err;
                }
                settle(readProviderUsage((result as any)?.usage));
                return result;
            },
            // A stream's usage arrives only at its end, after the request was
            // sent unchecked: a run with a spend cap does not stream.
            wrapStream: async ({ doStream }: any) => {
                if (meterAdmitsRequests()) {
                    throw new Error(
                        'A model request in a spend-capped run cannot stream',
                    );
                }
                return doStream();
            },
        },
    });
}
