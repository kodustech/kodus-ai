/**
 * The ONE resolution of "what does this model do with `temperature`".
 *
 * WHY IT EXISTS
 * The contract used to answer this question twice — `temperaturePolicy(cfg)`
 * when the module had an opinion, and a static `capabilities()
 * .supportsTemperature` boolean when it didn't. Two answers means a FALLBACK
 * RULE, and a fallback rule written out at each call site is a fallback rule
 * that will drift.
 *
 * It drifted: the runtime read `temperaturePolicy(cfg) ?? { adjustable }` while
 * the connect form read `temperaturePolicy(cfg) ?? capabilities()`. The openai
 * module returned `undefined` for NATIVE OpenAI on purpose — documented as "the
 * caller derives it from the static capability" — so for gpt-5.x / o-series the
 * form hid the field while the runtime resolved the stored value and sent it.
 * 26 production slots carry a temperature on those models; it only avoided a
 * 400 because the AI SDK strips the param for reasoning models on its way out.
 *
 * Both halves of that are gone now. The second answer was DELETED (there is no
 * `supportsTemperature` capability any more), every module declares
 * `temperaturePolicy` — enforced by `declared-facts.contract.spec.ts` — and the
 * one remaining default below exists only so a caller cannot crash on a module
 * that somehow has none. There is nothing left to disagree about.
 */

import type { ProviderModule } from './types';
import type { ProviderBuildConfig } from './types';
import type { TemperaturePolicy } from './model-types';

export function resolveTemperaturePolicy(
    module: ProviderModule | undefined,
    cfg: ProviderBuildConfig,
): TemperaturePolicy {
    if (!module) {
        return { kind: 'adjustable' };
    }

    // The module's own answer — the only answer. It knows, per its id + this
    // model, whether the request 400s, must be pinned, or is free.
    const declared = module.temperaturePolicy?.(cfg);
    if (declared) {
        return declared;
    }
    // Unreachable while the declared-facts contract holds. Permissive rather
    // than restrictive so a hypothetical undeclared module never hides a field
    // that works — and so this line can never quietly become a second rule.
    return { kind: 'adjustable' };
}
