/**
 * Generic temperature resolution — asks the provider module (via REGISTRY) for the
 * model's `temperaturePolicy`, instead of hardcoding which providers reject or pin
 * it. Provider-specific knowledge lives in the module; this stays provider-agnostic.
 */
import { REGISTRY } from './providers';
import { resolveTemperaturePolicy } from './providers/kernel/temperature';
import { BYOKProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from './byok-config';

/**
 * The temperature to actually send for a BYOK slot, resolved through the model's
 * {@link TemperaturePolicy}:
 *   - `unsupported` → `undefined` (omit the field; the provider 400s if it's sent).
 *   - `fixed`       → the pinned value, sent OVER whatever is stored (so an old
 *                     config saved with e.g. 0 can't degrade always-thinking Kimi).
 *   - `adjustable`  → the configured value, or `undefined` when none is set.
 *
 * Returns `undefined` when the value must be withheld or nothing is configured —
 * callers already treat `undefined` as "omit the field and let the provider default
 * apply", so no call site needs new branching. A provider without a
 * `temperaturePolicy` method (every provider but Anthropic) is treated as
 * `adjustable`.
 */
export function resolveByokTemperature(slot?: {
    provider?: BYOKProvider | string;
    model?: string;
    temperature?: number;
    /** Read by the resolved policy: DeepSeek withholds temperature only WHILE
     *  thinking, and an always-thinking GLM pins it. Omitting it from the
     *  signature made the parameter invisible to callers of a function that
     *  reads it. */
    reasoningEffort?: string;
}): number | undefined {
    const provider = slot?.provider as string | undefined;
    const module =
        provider && REGISTRY.has(provider) ? REGISTRY.get(provider) : undefined;

    // ONE resolution, shared with the connect form and the tuning validator —
    // see kernel/temperature.ts for why this is not inlined here any more.
    const policy = resolveTemperaturePolicy(module, slot as NormalizedModel);

    if (policy.kind === 'unsupported') return undefined;
    if (policy.kind === 'fixed') return policy.value;
    return slot?.temperature;
}
