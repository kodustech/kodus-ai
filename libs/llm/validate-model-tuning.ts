/**
 * Pure, transport-agnostic validation of the tuning a user configured for a BYOK
 * slot (temperature + reasoning effort) against the MODEL's own rules — the same
 * `temperaturePolicy` / `reasoningTraits` the runtime obeys. Asks the provider
 * module (via REGISTRY), so it stays provider-blind and a new model is a data
 * change in the module, never an edit here.
 *
 * Why it exists: the runtime SELF-CORRECTS these values (`resolveByokTemperature`
 * sends a `fixed` temperature OVER whatever is stored, and omits an `unsupported`
 * one), so a mis-set value never 400s — it is silently ignored. That silence is
 * the problem: a user who pins Kimi k2.7-code to 0.2 believes it takes effect. The
 * connect-time Test surfaces the mismatch out loud instead, so the client learns
 * the value won't be used BEFORE saving a config that quietly disagrees with it.
 */
import { REGISTRY } from './providers';
import { NON_REASONING_TRAITS } from './providers/kernel/reasoning-traits';
import type { NormalizedModel } from './byok-config';

export interface ModelTuningInput {
    provider?: string;
    model?: string;
    /** The temperature the user configured on the slot, if any. */
    temperature?: number;
    /** The reasoning effort the user picked ('none' = turn thinking off). */
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

export interface ModelTuningIssue {
    field: 'temperature' | 'reasoning';
    message: string;
}

/**
 * Return every way the configured tuning disagrees with the model's rules — empty
 * when it's sound (including for a provider with no policy, or an unknown one).
 * Pure: no I/O, no provider ids branched on here.
 */
export function validateModelTuning(
    input: ModelTuningInput,
): ModelTuningIssue[] {
    const issues: ModelTuningIssue[] = [];

    const module =
        input.provider && REGISTRY.has(input.provider)
            ? REGISTRY.get(input.provider)
            : undefined;
    if (!module) return issues;

    const cfg = input as NormalizedModel;
    const label = input.model?.trim() || 'This model';

    // Temperature vs the model's policy — only meaningful when the user set one.
    if (input.temperature != null) {
        const policy = module.temperaturePolicy?.(cfg) ?? {
            kind: 'adjustable' as const,
        };
        if (policy.kind === 'unsupported') {
            issues.push({
                field: 'temperature',
                message: `${label} does not accept a temperature — the value you set won't be sent. Clear the temperature field.`,
            });
        } else if (
            policy.kind === 'fixed' &&
            input.temperature !== policy.value
        ) {
            issues.push({
                field: 'temperature',
                message: `${label} always reasons, so its temperature is fixed at ${policy.value}; the ${input.temperature} you set won't be used. Set it to ${policy.value} or leave it unset.`,
            });
        }
    }

    // Turning reasoning OFF on a model that reasons unconditionally is a
    // contradiction the runtime can't honor — surface it rather than ignore it.
    if (input.reasoningEffort === 'none') {
        const traits = module.reasoningTraits?.(cfg) ?? NON_REASONING_TRAITS;
        if (traits.thinksByDefault && !traits.canDisableThinking) {
            issues.push({
                field: 'reasoning',
                message: `${label} always reasons and can't be turned off. Remove the "off" reasoning setting.`,
            });
        }
    }

    return issues;
}
