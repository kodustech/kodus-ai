/**
 * Anthropic model generations — which request shape a given Claude accepts.
 * Internal to the anthropic provider module: the ONE place this Anthropic-
 * specific knowledge lives, consumed by the module's `capabilities()` /
 * `reasoning()` / `supportsSamplingParams()`. Generic callers never import this
 * — they go through the ProviderModule contract via REGISTRY.
 *
 * Anthropic changed the thinking API twice, and each change is a hard 400 when
 * you send the wrong shape:
 *
 *   legacy   (3.x, 4.0/4.1, Sonnet 4.5, Opus 4.5, Haiku 4.5)
 *            thinking: { type: 'enabled', budgetTokens: N }   — required
 *            effort: rejected (Opus 4.5 accepts low/medium/high only)
 *            temperature / top_p / top_k: accepted
 *
 *   4.6      (Opus 4.6, Sonnet 4.6)
 *            thinking: { type: 'adaptive' } + effort           — recommended
 *            budgetTokens still works but is deprecated
 *            temperature: accepted
 *
 *   modern   (Opus 4.7/4.8, Opus 5, Sonnet 5)
 *            thinking: { type: 'adaptive' } + effort           — only option
 *            budgetTokens: 400
 *            temperature / top_p / top_k: 400
 *
 *   always   (Fable 5, Mythos 5)
 *            same as modern, but thinking cannot be turned off:
 *            { type: 'disabled' } is a 400, so it must be omitted entirely
 *
 * Source: https://platform.claude.com/docs/en/about-claude/models/migration-guide
 *
 * Only the *older* generations need enumerating — that list is closed. Anything
 * newer is matched by the open-ended patterns below, so a Claude released after
 * this file was written resolves to `modern` without a code change.
 *
 * Scope: real Anthropic endpoints only. `anthropic_compatible` providers (Kimi
 * Code, Z.ai, DeepSeek) speak the Anthropic protocol but implement only the
 * legacy thinking shape and do accept sampling params — the module's
 * `supportsSamplingParams()` short-circuits them to `true` and never runs their
 * model ids through this module.
 */

export type AnthropicGeneration =
    | 'legacy'
    | 'adaptive-4-6'
    | 'modern'
    | 'always-thinking'
    | 'unknown';

export interface AnthropicModelTraits {
    generation: AnthropicGeneration;
    /**
     * How to express "think" for this model. `none` means we could not identify
     * the model — callers should omit thinking config rather than guess, since
     * either shape is a 400 on the generation that doesn't accept it.
     */
    thinkingShape: 'adaptive' | 'budget' | 'none';
    /** Whether `thinking: { type: 'disabled' }` is accepted (Fable/Mythos: no). */
    canDisableThinking: boolean;
    /** Whether temperature / top_p / top_k may be sent at all. */
    supportsSamplingParams: boolean;
}

/**
 * Strip the decorations different hosts add around the bare model id:
 *   - our own `provider:model` pairs (`anthropic:claude-opus-5`)
 *   - Amazon Bedrock's provider prefix (`anthropic.claude-opus-5`)
 *   - Vertex's `@`-versioned snapshots (`claude-opus-4-5@20251101`)
 *   - dated snapshots (`claude-sonnet-4-5-20250929`)
 */
export function normalizeAnthropicModelName(modelName?: string): string {
    if (!modelName) return '';

    let name = modelName.trim().toLowerCase();

    const colon = name.indexOf(':');
    if (colon > -1) name = name.slice(colon + 1);

    if (name.startsWith('anthropic.')) name = name.slice('anthropic.'.length);

    name = name.split('@')[0];
    name = name.replace(/-\d{8}$/, '');

    return name;
}

/** Claude 2.x / 3.x — always the budget shape. */
const LEGACY_MAJOR = /^claude-[23](\b|[-.])/;

/** Claude 4 through 4.5, in either naming order (`opus-4-1`, `3-7-sonnet`). */
const LEGACY_4X =
    /^claude-(opus|sonnet|haiku)-4(-[0-5])?$/;

/** Claude 4.6 and 4.7+ — `-4-6` is its own generation, `-4-7` and up are modern. */
const FOUR_POINT_SIX = /^claude-(opus|sonnet|haiku)-4-6$/;
const FOUR_POINT_SEVEN_PLUS =
    /^claude-(opus|sonnet|haiku)-4-([7-9]|\d{2,})$/;

/** Claude 5 and beyond (`claude-opus-5`, `claude-sonnet-5`, a future `-6`). */
const MAJOR_FIVE_PLUS =
    /^claude-(opus|sonnet|haiku)-([5-9]|\d{2,})$/;

/** Thinking is permanently on for these — `disabled` is rejected. */
const ALWAYS_THINKING = /^claude-(fable|mythos)/;

export function resolveAnthropicModelTraits(
    modelName?: string,
): AnthropicModelTraits {
    const name = normalizeAnthropicModelName(modelName);

    const generation = resolveGeneration(name);

    return {
        generation,
        thinkingShape:
            generation === 'legacy'
                ? 'budget'
                : generation === 'unknown'
                  ? 'none'
                  : 'adaptive',
        canDisableThinking: generation !== 'always-thinking',
        supportsSamplingParams:
            generation === 'legacy' || generation === 'adaptive-4-6',
    };
}

function resolveGeneration(name: string): AnthropicGeneration {
    if (!name) return 'unknown';

    if (ALWAYS_THINKING.test(name)) return 'always-thinking';
    if (FOUR_POINT_SIX.test(name)) return 'adaptive-4-6';
    if (FOUR_POINT_SEVEN_PLUS.test(name) || MAJOR_FIVE_PLUS.test(name)) {
        return 'modern';
    }
    if (LEGACY_4X.test(name) || LEGACY_MAJOR.test(name)) return 'legacy';

    return 'unknown';
}

/**
 * Whether sampling params (temperature/top_p/top_k) may be sent for this
 * Anthropic model. `isAnthropic` is the REAL-anthropic gate: every other
 * provider (including `anthropic_compatible`) accepts them, so callers pass
 * `false` and get `true` back.
 */
export function supportsSamplingParams(
    isAnthropic: boolean,
    modelName?: string,
): boolean {
    if (!isAnthropic) return true;
    const { generation, supportsSamplingParams: allowed } =
        resolveAnthropicModelTraits(modelName);
    // An unrecognized Claude is more likely to be newer than older, and sending
    // temperature to a 4.7+ model fails the whole request. Withholding it only
    // costs determinism, so bias toward the request succeeding.
    return generation === 'unknown' ? false : allowed;
}
