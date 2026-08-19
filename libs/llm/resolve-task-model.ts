/**
 * resolveTaskSlot — the SINGLE task→slot routing primitive (slice 04b).
 *
 * "Decide which model + creds for THIS task": resolve the routed model id via
 * `StaticTaskStrategy` over the org's config, materialize that model's slot
 * (ciphertext-bearing), or degrade to `{ slot: undefined }` when there's no BYOK.
 * NO model is BUILT here — `buildModelFromSlot` and everything that RUNS a model
 * live behind `LLM.run`; a consumer passes this slot to `LLM.run`.
 *
 * Degradation contract (never throws):
 *  - no BYOK (config null/undefined/non-v2) → undefined slot → managed default.
 *  - BLOCKED verdict (modelId null) → undefined slot → managed default.
 *  - an unresolvable routed slot (managed/incomplete) → undefined slot.
 *
 * Secret hygiene: the slot carries ENCRYPTED apiKey ciphertext; `resolveTaskSlot`
 * never decrypts (only `buildModelFromSlot`, elsewhere, touches plaintext).
 */

import {
    isByokConfig,
    type BYOKConfig,
    type LlmTask,
    type NormalizedModel,
} from './byok-config';
import type { RequestContext, RoutingVerdict } from './routing-strategy';
import { StaticTaskStrategy } from './static-task-strategy';
import { resolveModelSlot } from './resolve-model-slot';

// Manual routing policy (Phase 4). Stateless + dependency-free — instantiated once.
const strategy = new StaticTaskStrategy();

/**
 * Resolve `task` over the org's config to a slot (ciphertext-bearing) WITHOUT
 * building a model — the "decide which model + creds" step. BYOK when the org
 * routes one for the task; otherwise `{ slot: null }` → the caller degrades to
 * the managed/env default. Consumers that need to RUN the model pass this slot
 * to `LLM.run` (which builds + wraps it); consumers that only need the routing
 * decision read `.slot` / `.verdict` directly.
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

