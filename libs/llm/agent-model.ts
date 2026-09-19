/**
 * The ONE way every agent resolves its model — symmetric to
 * `createAgentRunContext`. Resolves the BYOK model AND wraps it in the BYOK
 * concurrency limiter + failure reporter, so concurrency gating AND error
 * reporting (the `byok.llm_errors_threshold` notification) are identical across
 * every harness consumer instead of each wiring it differently.
 *
 * Lives in @libs/llm (infra), not the harness — the engine stays model-agnostic.
 */
import type { LanguageModel } from 'ai';

import {
    buildModelFromSlot,
    type ByokModelOptions,
} from '@libs/llm/byok-to-vercel';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';

export interface ResolveAgentModelOptions {
    organizationId?: string;
    provider?: string;
    queueTimeoutMs?: number;
    /** Model-build options forwarded to `buildModelFromSlot` — notably
     *  `structuredOutputs` for the structured-output (generateObject) path.
     *  Omit for the plain agentic loop. */
    modelOptions?: ByokModelOptions;
    /** Force a default model id on the env/managed path (no BYOK slot) — the
     *  trial / public-demo override (e.g. cli-review's SUMMARY_MODEL). Threaded
     *  to `buildModelFromSlot`; ignored when a real slot resolves. */
    defaultModelOverride?: string;
    /** Wire to `ByokErrorCounter.record` so BYOK failures drive the
     *  `byok.llm_errors_threshold` notification — parity with code-review. */
    reporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
    /** An ALREADY-BUILT model to run instead of resolving one from the slot.
     *  The one caller is the eval harness, which builds bespoke models that no
     *  slot can express (the Codex-subscription transport). Without this seam the
     *  eval's model was silently dropped and the run fell back to the env default
     *  — the benchmark then labelled results with a model that never ran.
     *  Still goes through wrapByokModel so the limiter/reporter behave the same. */
    prebuiltModel?: LanguageModel;
}

export function resolveAgentModel(
    slot: NormalizedModel | undefined,
    opts: ResolveAgentModelOptions = {},
): LanguageModel {
    // Build the model from the ONE resolved slot; the limiter keys off that slot.
    return wrapByokModel(
        opts.prebuiltModel ??
            buildModelFromSlot(slot, opts.modelOptions, opts.defaultModelOverride),
        {
            byokConfig: slot,
            organizationId: opts.organizationId,
            provider: opts.provider ?? slot?.provider,
            ...(opts.queueTimeoutMs != null
                ? { queueTimeoutMs: opts.queueTimeoutMs }
                : {}),
            ...(opts.reporter ? { reporter: opts.reporter } : {}),
        },
    );
}
