/**
 * The ONE way every agent resolves its model — symmetric to
 * `createAgentRunContext`. Resolves the BYOK model AND wraps it in the BYOK
 * concurrency limiter + failure reporter, so concurrency gating AND error
 * reporting (the `byok.llm_errors_threshold` notification) are identical across
 * every harness consumer instead of each wiring it differently.
 *
 * Lives in @libs/llm (infra), not the harness — the engine stays model-agnostic.
 */
import type { BYOKConfig } from '@kodus/kodus-common/llm';
import type { LanguageModel } from 'ai';

import { byokToVercelModel } from '@libs/llm/byok-to-vercel';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';

export interface ResolveAgentModelOptions {
    organizationId?: string;
    provider?: string;
    queueTimeoutMs?: number;
    /** Wire to `ByokErrorCounter.record` so BYOK failures drive the
     *  `byok.llm_errors_threshold` notification — parity with code-review. */
    reporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
}

export function resolveAgentModel(
    byokConfig: BYOKConfig | undefined,
    opts: ResolveAgentModelOptions = {},
): LanguageModel {
    return wrapByokModel(byokToVercelModel(byokConfig), {
        byokConfig,
        organizationId: opts.organizationId,
        provider: opts.provider ?? byokConfig?.main?.provider,
        ...(opts.queueTimeoutMs != null
            ? { queueTimeoutMs: opts.queueTimeoutMs }
            : {}),
        ...(opts.reporter ? { reporter: opts.reporter } : {}),
    });
}
