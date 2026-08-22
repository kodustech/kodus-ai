/**
 * Generic sampling-param resolution — asks the provider module (via REGISTRY)
 * whether a slot may carry temperature, instead of hardcoding which providers
 * reject it. Provider-specific knowledge lives in the module's
 * `supportsSamplingParams()`; this stays provider-agnostic.
 */
import { REGISTRY } from './providers';
import { BYOKProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from './byok-config';

/**
 * The temperature to actually send for a BYOK slot: the configured value,
 * unless the resolved provider module reports the model would reject it.
 *
 * Returns `undefined` both when nothing is configured and when the value must
 * be withheld — callers already treat `undefined` as "omit the field and let
 * the provider default apply", so no call site needs new branching. A provider
 * without a `supportsSamplingParams` method (every provider but Anthropic) is
 * treated as accepting the param.
 */
export function resolveByokTemperature(slot?: {
    provider?: BYOKProvider | string;
    model?: string;
    temperature?: number;
}): number | undefined {
    if (slot?.temperature === undefined) return undefined;

    const provider = slot.provider as string | undefined;
    const module =
        provider && REGISTRY.has(provider) ? REGISTRY.get(provider) : undefined;
    const allowed =
        module?.supportsSamplingParams?.(slot as NormalizedModel) ?? true;

    return allowed ? slot.temperature : undefined;
}
