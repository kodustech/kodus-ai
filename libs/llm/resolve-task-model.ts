/**
 * resolveTaskModel — the SINGLE task→model resolution entry point (slice 04b,
 * plan 04b-01, TRACER).
 *
 * Every native consumer calls this in place of reading `.main`/`.fallback`:
 * "give me the LanguageModel for THIS task, resolved via `StaticTaskStrategy`
 * over the org's config, or the managed/env default if no BYOK." It resolves
 * the routed model id for the task (verdict), materializes that model's slot
 * (ciphertext-bearing), and builds the LanguageModel via `buildModelFromSlot`.
 *
 * Degradation contract (never throws):
 *  - no BYOK (config null/undefined/non-v2) → undefined slot → env/managed default.
 *  - BLOCKED verdict (modelId null) → undefined slot → env/managed default.
 *  - an unresolvable routed slot (managed/incomplete) → undefined slot → env default.
 *
 * Secret hygiene (T-04b-01-01): the slot carries ENCRYPTED apiKey ciphertext;
 * only `buildModelFromSlot`'s `decrypt()` touches plaintext, in local scope. No
 * returned field (`modelName`, `slot`, `verdict.reason`) carries key material.
 */
import type { LanguageModel } from 'ai';

import {
    isByokConfig,
    type BYOKConfig,
    type LlmTask,
    type NormalizedModel,
} from './byok-config';
import type { RequestContext, RoutingVerdict } from './routing-strategy';
import { StaticTaskStrategy } from './static-task-strategy';
import { resolveModelSlot } from './resolve-model-slot';
import { buildModelFromSlot, getModelName } from './byok-to-vercel';

// Manual routing policy (Phase 4). Stateless + dependency-free — instantiated once.
const strategy = new StaticTaskStrategy();

export interface ResolveTaskModelOptions {
    /** Per-request routing inputs (folder/repo override, parent-task inherit). */
    ctx?: RequestContext;
    /** Opt the OpenAI-compatible branch into `response_format: json_schema`. */
    structuredOutputs?: boolean;
    /** Force a default model id when there is no BYOK (trial/public-demo). */
    defaultModelOverride?: string;
}

export interface ResolvedTaskModel {
    /** The built Vercel AI SDK model for the task. */
    model: LanguageModel;
    /** `${provider}:${model}` for the resolved slot, or the env-default name. */
    modelName: string;
    /** The resolved slot (ciphertext apiKey), or undefined for the env/managed path. */
    slot: NormalizedModel | undefined;
    /** The routing verdict, or undefined when the config is not v2. */
    verdict: RoutingVerdict | undefined;
}

/**
 * Resolve `task` over the org's config to a slot (ciphertext-bearing) WITHOUT
 * building a model — the "decide which model + creds" step. BYOK when the org
 * routes one for the task; otherwise `{ slot: null }` → the caller degrades to
 * the managed/env default. This is the single resolution primitive:
 * `resolveTaskModel` is exactly this plus `buildModelFromSlot`, and consumers
 * that need the slot itself (to thread it down, or to rebuild with per-call
 * flags in `withStructuredOutputFallback`) call this directly and read `.slot`.
 *
 * Degrade contract (never throws): non-v2 / BLOCKED verdict / unresolvable slot
 * → `{ slot: undefined }`.
 *
 * Secret hygiene: the slot carries ENCRYPTED apiKey ciphertext
 * (`resolveModelSlot` never decrypts); only `buildModelFromSlot` touches
 * plaintext.
 */
export function resolveTaskSlot(
    config: BYOKConfig | null | undefined,
    task: LlmTask,
    options: { ctx?: RequestContext } = {},
): { slot: NormalizedModel | undefined; verdict: RoutingVerdict | undefined } {
    if (!isByokConfig(config)) {
        return { slot: undefined, verdict: undefined };
    }

    const verdict = strategy.resolve(task, options.ctx ?? {}, config);

    if (!verdict.modelId) {
        return { slot: undefined, verdict };
    }
    const routed = resolveModelSlot(config, verdict.modelId);
    // id-THEN-name: a legacy NAME override applies onto the resolved slot's
    // `.model` (the slot still supplies the credential/ciphertext).
    const slot =
        routed && verdict.modelName
            ? { ...routed, model: verdict.modelName }
            : routed;

    return { slot, verdict };
}

/**
 * Resolve the LanguageModel for `task` — `resolveTaskSlot` + build.
 */
export function resolveTaskModel(
    config: BYOKConfig | null | undefined,
    task: LlmTask,
    options: ResolveTaskModelOptions = {},
): ResolvedTaskModel {
    const { slot, verdict } = resolveTaskSlot(config, task, {
        ctx: options.ctx,
    });

    const model = buildModelFromSlot(
        slot,
        { structuredOutputs: options.structuredOutputs },
        options.defaultModelOverride,
    );

    const modelName = slot
        ? `${slot.provider}:${slot.model}`
        : getModelName(undefined, options.defaultModelOverride);

    return { model, modelName, slot, verdict };
}
