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
import { createLogger } from '@libs/core/log/logger';
import {
    MAX_REFUSAL_RETRIES,
    rejectedReasoning,
    rememberRefusal,
    withoutReasoningField,
    withoutRefusedFields,
    withReasoningOff,
} from '@libs/llm/rejected-reasoning-field';
import {
    runInByokEnvelope,
    type ByokFailureReporter,
} from '@libs/llm/byok-call-envelope';

const logger = createLogger('ByokModelWrapper');

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
    reporter?: ByokFailureReporter;
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
                const generate = async () => {
                    const sent = withoutRefusedFields(
                        params,
                        slot,
                        opts.organizationId,
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
                                        ? withReasoningOff(attempt, refusal.field)
                                        : withoutReasoningField(
                                              attempt,
                                              refusal.field,
                                          )
                                    : undefined;
                            if (!refusal || !retry) throw err;
                            const { field, off } = refusal;
                            rememberRefusal(
                                slot,
                                opts.organizationId,
                                field,
                                Date.now(),
                                off,
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
                // The limiter keys off the ONE resolved slot the org configured
                // for this task (`slot`, above). The envelope owns admission,
                // the tpm estimate/reconcile, and classify + cooldown + report
                // on failure; the refusal retry above stays here because it
                // edits AI SDK params.
                //
                // Pin T to the SDK's generate-result type so inference doesn't
                // collapse to `unknown` (the middleware return type would then
                // reject it).
                return runInByokEnvelope<ByokGenerateResult>(
                    {
                        slot,
                        organizationId: opts.organizationId,
                        provider: opts.provider,
                        queueTimeoutMs: opts.queueTimeoutMs,
                        reporter: opts.reporter,
                    },
                    {
                        abortSignal: params?.abortSignal,
                        prompt: params?.prompt,
                        usageTokens: extractUsageTotal,
                    },
                    generate,
                );
            },
        },
    });
}
