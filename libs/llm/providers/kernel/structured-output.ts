/**
 * The ONE resolution of "how does a structured call for this config leave the
 * machine" — the WIRE channel, not a capability leaflet.
 *
 * WHY IT EXISTS
 * The question used to be answered twice, by two things that could not see the
 * same inputs:
 *
 *   capabilities(model).structuredOutput   — model id only
 *   build(cfg).supportsStructuredOutputs   — model id AND baseURL AND provider id
 *
 * They disagreed in both directions, measured, and `structured-output.contract
 * .spec.ts` pinned the disagreement as harmless because nothing branched on it.
 * That stopped being true: a call that goes out as bare `json_object` carries NO
 * shape and no keyword, and several providers either reject it outright ("must
 * contain the word 'json'") or accept it and let the model invent a shape. Both
 * land in the dedup fail-open that publishes every duplicate (issue #1916).
 *
 * So the branch exists now, and it reads THIS — the module's own answer, taking
 * the whole config, exactly like `temperaturePolicy(cfg)`. `build()` derives its
 * `supportsStructuredOutputs` from the same call, so the declaration and the
 * request body are one expression and cannot drift.
 */

import type { ProviderBuildConfig, ProviderModule } from './types';
import type { StructuredOutputMode } from './reasoning-traits';

export function resolveStructuredOutputPolicy(
    module: ProviderModule | undefined,
    cfg: ProviderBuildConfig,
): StructuredOutputMode {
    // The module's own answer — the only answer. It knows, per its id + this
    // model + this baseURL, what response_format (if any) the request carries.
    const declared = module?.structuredOutputPolicy?.(cfg);
    if (declared) {
        return declared;
    }
    // Unreachable while the declared-facts contract holds. 'json_schema' is the
    // conservative default HERE because it is the one that changes nothing: a
    // caller reading this only acts on 'json_object' (it writes the contract into
    // the prompt). An undeclared module therefore keeps today's behaviour rather
    // than silently gaining a prompt it was never tested with.
    return 'json_schema';
}
