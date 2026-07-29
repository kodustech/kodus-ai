/**
 * Wrap a model so every generate goes through the BYOK concurrency limiter
 * (process-wide rate limit) AND reports BYOK failures (drives the
 * `byok.llm_errors_threshold` notification).
 *
 * Done at the MODEL level (AI SDK `wrapLanguageModel`) so any agent runner stays
 * model-agnostic — the failure reporter is injected directly (no AsyncLocalStorage).
 */
import { wrapLanguageModel, type LanguageModel } from 'ai';

import { BYOKConfig } from '@kodus/kodus-common/llm';

import { runWithBYOKLimiter } from '@libs/llm/byok-to-vercel';
import {
    attachClassification,
    classifyLLMError,
} from '@libs/llm/error-classifier';

export interface WrapByokModelOptions {
    byokConfig?: BYOKConfig;
    organizationId?: string;
    provider?: string;
    /** @deprecated No-op since 04b-02 — the limiter keys off the single resolved
     *  slot (`byokConfig.main`), not a `main`/`fallback`/`internal` role. Kept on
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
): LanguageModel {
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
                            attachClassification(
                                err,
                                classifyLLMError(err, opts.provider),
                            );
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
                // for this task — the carrier `.main` read happens here at the
                // wrapper boundary, not inside the limiter core.
                return runWithBYOKLimiter(
                    {
                        slot: opts.byokConfig?.main,
                        organizationId: opts.organizationId,
                        abortSignal: params?.abortSignal,
                        queueTimeoutMs: opts.queueTimeoutMs,
                    },
                    run,
                    'llm-call',
                );
            },
        },
    });
}
