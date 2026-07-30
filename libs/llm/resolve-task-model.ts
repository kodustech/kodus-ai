/**
 * resolveTaskModel — the SINGLE task→model resolution entry point (slice 04b,
 * plan 04b-01, TRACER).
 *
 * Every v2-native consumer calls this in place of reading `.main`/`.fallback`:
 * "give me the LanguageModel for THIS task, resolved via `StaticTaskStrategy`
 * over the org's v2 config, or the managed/env default if no BYOK." It resolves
 * the routed model id for the task (verdict), materializes that model's slot
 * (ciphertext-bearing), and builds the LanguageModel via `buildModelFromSlot`.
 *
 * Degradation contract (never throws):
 *  - no BYOK (config null/undefined/non-v2) → null slot → env/managed default.
 *  - BLOCKED verdict (modelId null) → null slot → env/managed default.
 *  - an unresolvable routed slot (managed/incomplete) → null slot → env default.
 *
 * Secret hygiene (T-04b-01-01): the slot carries ENCRYPTED apiKey ciphertext;
 * only `buildModelFromSlot`'s `decrypt()` touches plaintext, in local scope. No
 * returned field (`modelName`, `slot`, `verdict.reason`) carries key material.
 */
import type { LanguageModel } from 'ai';
import type { BYOKConfig } from '@libs/llm/byok-config';

import {
    isV2Config,
    type BYOKConfigV2,
    type LlmTask,
    type NormalizedModel,
} from './byok-config';
import type { RequestContext, RoutingVerdict } from './routing-strategy';
import { StaticTaskStrategy } from './static-task-strategy';
import { resolveModelSlotFromV2 } from './normalize-byok-config';
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
    /** Reserved for limiter scoping; not read by the resolver itself. */
    organizationId?: string;
}

export interface ResolvedTaskModel {
    /** The built Vercel AI SDK model for the task. */
    model: LanguageModel;
    /** `${provider}:${model}` for the resolved slot, or the env-default name. */
    modelName: string;
    /** The resolved slot (ciphertext apiKey), or null for the env/managed path. */
    slot: NormalizedModel | null;
    /** The routing verdict, or null when the config is not v2. */
    verdict: RoutingVerdict | null;
}

/**
 * Resolve the LanguageModel for `task` over the org's v2 config.
 */
export function resolveTaskModel(
    config: BYOKConfigV2 | null | undefined,
    task: LlmTask,
    options: ResolveTaskModelOptions = {},
): ResolvedTaskModel {
    let slot: NormalizedModel | null = null;
    let verdict: RoutingVerdict | null = null;

    if (isV2Config(config)) {
        verdict = strategy.resolve(task, options.ctx ?? {}, config);
        if (verdict.modelId) {
            const routed = resolveModelSlotFromV2(config, verdict.modelId);
            // id-THEN-name: a legacy NAME override applies onto the resolved
            // slot's `.model` (the slot still supplies the credential/ciphertext).
            slot =
                routed && verdict.modelName
                    ? { ...routed, model: verdict.modelName }
                    : routed;
        }
    }

    const model = buildModelFromSlot(
        slot ?? undefined,
        { structuredOutputs: options.structuredOutputs },
        options.defaultModelOverride,
    );

    const modelName = slot
        ? `${slot.provider}:${slot.model}`
        : getModelName(undefined, options.defaultModelOverride);

    return { model, modelName, slot, verdict };
}

/**
 * Resolve the org's v2 config to the legacy `{main, fallback}` carrier for ONE
 * task, WITHOUT building a model. This is the v2-native source for the peripheral
 * consumers that still hand a `{main,fallback}`-shaped `BYOKConfig` to a shared
 * helper whose own `.main`/`.fallback` reads die in a later cleanup wave
 * (`runStructuredReviewCall`, `resolveAgentModel`, the reference-detector
 * carrier): they source `getBYOKConfigV2Raw` and route it through here instead of
 * `getBYOKConfig`, so the credential/model comes from the v2 `models[]`/routing
 * rather than the collapsed legacy `main`.
 *
 * Mirrors `resolveTaskModel`'s resolution (StaticTaskStrategy → routed slot, with
 * an id-THEN-name legacy override) plus the org's own routed fallback. Returns
 * `undefined` for a non-v2 / absent config or a BLOCKED/unresolvable verdict, so
 * the caller falls back to the managed/env default exactly as with a missing
 * config. Secret hygiene: the returned slot carries ENCRYPTED apiKey ciphertext
 * (`resolveModelSlotFromV2` never decrypts); only `buildModelFromSlot` downstream
 * touches plaintext.
 */
export function resolveTaskByokConfig(
    config: BYOKConfigV2 | null | undefined,
    task: LlmTask,
    options: { ctx?: RequestContext } = {},
): BYOKConfig | undefined {
    if (!isV2Config(config)) {
        return undefined;
    }
    const verdict = strategy.resolve(task, options.ctx ?? {}, config);
    if (!verdict.modelId) {
        return undefined;
    }
    const routed = resolveModelSlotFromV2(config, verdict.modelId);
    const main =
        routed && verdict.modelName
            ? { ...routed, model: verdict.modelName }
            : routed;
    if (!main) {
        return undefined;
    }
    const fallback = resolveModelSlotFromV2(
        config,
        config.routing?.fallbackModelId,
    );
    return { main, ...(fallback ? { fallback } : {}) } as BYOKConfig;
}
