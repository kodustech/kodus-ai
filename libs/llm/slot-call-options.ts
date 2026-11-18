import { resolveByokTemperature } from './sampling-params';
import type { NormalizedModel } from './byok-config';

/**
 * The per-model call tuning shared by EVERY LLM consumer (code review, PR
 * summary, conversation, kody rules, ...). Mapping a resolved slot to the AI SDK
 * generateText/generateObject options in ONE place is the standard: a new agent
 * or a new provider honors `temperature` / `maxOutputTokens` for free, with no
 * per-call-site spread to remember (forgetting it is exactly what silently
 * dropped the review path's tuning).
 *
 * Scope: the "plain" generation knobs only. Reasoning has its own
 * provider-specific mapping in `reasoning-options.ts`; concurrency lives in the
 * limiter. Consumers may still layer their own DEFAULT on top (e.g. the
 * conversation agent caps output when the slot leaves it unset) -- this helper
 * only reads what the slot actually configured.
 */
export interface SlotCallOptions {
    temperature?: number;
    maxOutputTokens?: number;
}

/**
 * Provider ids that use the Anthropic wire protocol but are not registered
 * model families in @ai-sdk/anthropic. The SDK silently caps every call with
 * an unrecognised model id at 4096 output tokens. We inject a large default
 * so the upstream can use its own ceiling instead.
 *
 * Brand providers (moonshot/zai) store their own id on the slot -- they only
 * present as 'anthropic_compatible' inside brand.ts's build() call. The generic
 * 'anthropic_compatible' id covers self-hosted/custom endpoints (DeepSeek, etc.)
 * that carry no brand of their own.
 */
const ANTHROPIC_WIRE_PROVIDERS = new Set([
    'anthropic_compatible',
    'moonshot', // Kimi models
    'zai',      // GLM models
]);

export function resolveSlotCallOptions(
    slot: Pick<NormalizedModel, 'provider' | 'model' | 'temperature' | 'maxOutputTokens'> | undefined,
): SlotCallOptions {
    const options: SlotCallOptions = {};

    // Read temperature through `resolveByokTemperature`, not raw: it withholds
    // the configured value on Anthropic models that reject sampling params
    // (4.7+ 400s the whole request when temperature is present). Keeps this
    // shared path in lockstep with the direct `resolveByokTemperature` callers.
    const temperature = resolveByokTemperature(slot as NormalizedModel ?? undefined);
    if (typeof temperature === 'number') {
        options.temperature = temperature;
    }

    // A non-positive max-output means "use the model default" -- omit it so the
    // provider picks its own ceiling rather than being pinned to 0.
    if (typeof slot?.maxOutputTokens === 'number' && slot.maxOutputTokens > 0) {
        options.maxOutputTokens = slot.maxOutputTokens;
    }

    // @ai-sdk/anthropic caps output at 4096 for any model id it does not
    // recognise. @ai-sdk/anthropic only recognises hyphenated 'claude-' ids;
    // every other id on an Anthropic-wire transport (Kimi, GLM, DeepSeek,
    // MiniMax, underscore-prefixed claude ids, ...) is unknown to the SDK and
    // silently floors every call to 4096 when maxOutputTokens is left unset.
    // Send a large default so the model can use its own ceiling instead.
    //
    // The guard uses ANTHROPIC_WIRE_PROVIDERS rather than just
    // 'anthropic_compatible' because brand slots (moonshot/zai) keep the brand
    // id on the slot -- they only present as 'anthropic_compatible' at build time.
    if (
        !options.maxOutputTokens &&
        ANTHROPIC_WIRE_PROVIDERS.has((slot?.provider as string) ?? '') &&
        !/^claude-/i.test(slot?.model ?? '')
    ) {
        options.maxOutputTokens = 32_768;
    }

    return options;
}
