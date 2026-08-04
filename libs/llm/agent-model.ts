/**
 * The ONE way every agent resolves its model — symmetric to
 * `createAgentRunContext`. Resolves the BYOK model AND wraps it in the BYOK
 * concurrency limiter + failure reporter, so concurrency gating AND error
 * reporting (the `byok.llm_errors_threshold` notification) are identical across
 * every harness consumer instead of each wiring it differently.
 *
 * Lives in @libs/llm (infra), not the harness — the engine stays model-agnostic.
 */
import type { NormalizedByokConfig } from '@libs/llm/byok-config';
import type { LanguageModel } from 'ai';

import { buildModelFromSlot } from '@libs/llm/byok-to-vercel';
import type { NormalizedModel } from '@libs/llm/byok-config';
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
    slot: NormalizedModel | undefined,
    opts: ResolveAgentModelOptions = {},
): LanguageModel {
    // Build the model from the ONE resolved slot. The limiter still keys off a
    // `{main}` carrier, so reconstruct it here at the wrapper boundary — the
    // builder itself never reads `.main`/`.fallback`.
    return wrapByokModel(buildModelFromSlot(slot), {
        byokConfig: slot ? ({ main: slot } as NormalizedByokConfig) : undefined,
        organizationId: opts.organizationId,
        provider: opts.provider ?? slot?.provider,
        ...(opts.queueTimeoutMs != null
            ? { queueTimeoutMs: opts.queueTimeoutMs }
            : {}),
        ...(opts.reporter ? { reporter: opts.reporter } : {}),
    });
}
