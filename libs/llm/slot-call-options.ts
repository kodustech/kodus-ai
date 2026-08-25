import { resolveByokTemperature } from './sampling-params';
import type { NormalizedModel } from './byok-config';

/**
 * The per-model call tuning shared by EVERY LLM consumer (code review, PR
 * summary, conversation, kody rules, …). Mapping a resolved slot → the AI SDK
 * generateText/generateObject options in ONE place is the standard: a new agent
 * or a new provider honors `temperature` / `maxOutputTokens` for free, with no
 * per-call-site spread to remember (forgetting it is exactly what silently
 * dropped the review path's tuning).
 *
 * Scope: the "plain" generation knobs only. Reasoning has its own
 * provider-specific mapping in `reasoning-options.ts`; concurrency lives in the
 * limiter. Consumers may still layer their own DEFAULT on top (e.g. the
 * conversation agent caps output when the slot leaves it unset) — this helper
 * only reads what the slot actually configured.
 */
export interface SlotCallOptions {
    temperature?: number;
    maxOutputTokens?: number;
}

export function resolveSlotCallOptions(
    slot: NormalizedModel | undefined,
): SlotCallOptions {
    const options: SlotCallOptions = {};

    // Read temperature through `resolveByokTemperature`, not raw: it withholds
    // the configured value on Anthropic models that reject sampling params
    // (4.7+ 400s the whole request when temperature is present). Keeps this
    // shared path in lockstep with the direct `resolveByokTemperature` callers.
    const temperature = resolveByokTemperature(slot ?? undefined);
    if (typeof temperature === 'number') {
        options.temperature = temperature;
    }

    // A non-positive max-output means "use the model default" → omit it so the
    // provider picks its own ceiling rather than being pinned to 0.
    if (typeof slot?.maxOutputTokens === 'number' && slot.maxOutputTokens > 0) {
        options.maxOutputTokens = slot.maxOutputTokens;
    }

    return options;
}
