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

import {
    runWithBYOKLimiter,
    type BYOKLimiterRole,
} from '@libs/llm/byok-to-vercel';
import {
    attachClassification,
    classifyLLMError,
} from '@libs/llm/error-classifier';

export interface WrapByokModelOptions {
    byokConfig?: BYOKConfig;
    organizationId?: string;
    provider?: string;
    role?: BYOKLimiterRole;
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

                return runWithBYOKLimiter(
                    {
                        byokConfig: opts.byokConfig,
                        organizationId: opts.organizationId,
                        role: opts.role ?? 'main',
                        abortSignal: params?.abortSignal,
                        queueTimeoutMs: opts.queueTimeoutMs,
                    },
                    run,
                    opts.role ?? 'main',
                );
            },
        },
    });
}
