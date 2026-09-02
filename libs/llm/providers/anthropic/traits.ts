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

import type { ReasoningConfig } from '../kernel/model-types';

export type AnthropicGeneration =
    /** Claude 2.x and 3.0–3.5: no extended thinking AT ALL. Distinct from
     *  `legacy` (3.7–4.5), which thinks with a token budget. They were one
     *  generation here while `anthropicReasoningConfig` in this same file drew
     *  the line correctly at 3.7 — so the capability table said "does not
     *  reason" and the emitter sent `thinking:{type:enabled,budget_tokens}`
     *  anyway. No production slot runs one today; the contradiction is what is
     *  being removed, before one does. */
    | 'pre-thinking'
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
 *   - Bedrock's cross-region inference profiles (`global.anthropic.claude-opus-4-7`)
 *   - Bedrock's version suffix (`…claude-sonnet-4-5-20250929-v1:0`)
 *   - Vertex's `@`-versioned snapshots (`claude-opus-4-5@20251101`)
 *   - dated snapshots (`claude-sonnet-4-5-20250929`)
 *
 * A decoration this misses is not a cosmetic miss: the id falls through to
 * `unknown`, and `unknown` withholds temperature and omits thinking config
 * entirely. Every Bedrock-hosted Claude in production carries one of the two
 * Bedrock decorations, which is exactly how they all resolved to `unknown`.
 */
export function normalizeAnthropicModelName(modelName?: string): string {
    if (!modelName) return '';

    let name = modelName.trim().toLowerCase();

    // Bedrock stamps a version onto the id (`…-v1:0`). It has to go BEFORE the
    // `provider:model` rule below, which otherwise keeps only what follows the
    // colon — the string "0".
    name = name.replace(/-v\d+:\d+$/, '');

    const colon = name.indexOf(':');
    if (colon > -1) name = name.slice(colon + 1);

    // Cross-region inference profiles scope the id by region; the model behind
    // `us.` / `eu.` / `global.` is the same model, with the same request shape.
    name = name.replace(/^(us|eu|apac|us-gov|global)\./, '');

    if (name.startsWith('anthropic.')) name = name.slice('anthropic.'.length);

    name = name.split('@')[0];
    name = name.replace(/-\d{8}$/, '');

    return name;
}

/** Claude 2.x / 3.x — always the budget shape. */
// Extended thinking arrives with 3.7. Everything earlier in the 2.x/3.x line
// has no thinking parameter to send, which is a DIFFERENT fact from "thinks
// with a budget" — and one regex used to answer both.
const LEGACY_MAJOR = /^claude-3-7(\b|[-.])/;
const PRE_THINKING = /^claude-[23](\b|[-.])/;

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
                : generation === 'unknown' || generation === 'pre-thinking'
                  ? 'none'
                  : 'adaptive',
        canDisableThinking: generation !== 'always-thinking',
        // `pre-thinking` belongs here for the opposite reason to the others: it
        // takes a temperature precisely BECAUSE it never thinks. Leaving it out
        // would have traded one wrong answer for another — silently withholding
        // a setting that works on every Claude 3.5.
        supportsSamplingParams:
            generation === 'legacy' ||
            generation === 'adaptive-4-6' ||
            generation === 'pre-thinking',
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
    // AFTER the 3.7 check above, so `claude-3-7` never falls in here.
    if (PRE_THINKING.test(name)) return 'pre-thinking';

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

/**
 * The reasoning config for a Claude model — the Anthropic family owner's single
 * answer to "does this model think, and in which shape". Two axes the coarser
 * `generation` alone can't express:
 *   - WHICH thinks: extended thinking started at Claude 3.7, so 2.x / 3.0 / 3.5
 *     have NO reasoning (their generation is 'legacy' too, but they don't think).
 *   - WHICH SHAPE: budget (3.7 through 4.5) vs adaptive (4.6+, 5.x, Fable/Mythos).
 *
 * Every consumer (the model catalog, and the bedrock/vertex host modules that
 * serve Claude) resolves reasoning through here, so there is ONE source instead
 * of a per-host regex that drifts (bedrock reported none; vertex reported budget
 * for adaptive-only 4.7+).
 */
export function anthropicReasoningConfig(
    model?: string,
): ReasoningConfig | undefined {
    const name = normalizeAnthropicModelName(model);
    // Extended thinking exists only on 3.7, the 4.x line, 5.x, and Fable/Mythos.
    const reasons =
        /^claude-3-7(\b|[-.])/.test(name) ||
        /^claude-(opus|sonnet|haiku)-([4-9]|\d{2,})/.test(name) ||
        /^claude-(fable|mythos)/.test(name);
    if (!reasons) return undefined;

    return resolveAnthropicModelTraits(model).thinkingShape === 'adaptive'
        ? { type: 'adaptive', options: ['low', 'medium', 'high'] }
        : { type: 'budget', options: { min: 1024, default: 3000 } };
}
