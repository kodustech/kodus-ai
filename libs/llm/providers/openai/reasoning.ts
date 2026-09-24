import type { ReasoningConfig } from '../kernel/model-types';

/** o-series and gpt-5 are OpenAI's reasoning families (level-based effort). Also
 *  gates the module's temperature policy (reasoners reject temperature).
 *  Delegates: the rule lives in the model layer, not once per provider. */
export { isOpenAiReasonerId as isOpenAiReasoner } from '../kernel/model-family';

/**
 * OpenAI reasoning config — the OpenAI family owner's answer. gpt-5 exposes
 * medium/high; o-series and the deep-research line expose low/medium/high.
 * Returns undefined for non-reasoning OpenAI models (gpt-4o, gpt-3.5, …).
 */
export function openaiReasoningConfig(
    model?: string,
): ReasoningConfig | undefined {
    if (!model) return undefined;
    const m = model.toLowerCase();
    // gpt-6 names its own levels when it refuses one: low/medium/high/xhigh.
    // `xhigh` has no ReasoningEffort member, so the picker stops at high.
    // Same shape as isOpenAiReasonerId's regex — one or two digits, excluding
    // the whole pre-5 3x/4x range (gpt-40/gpt-41/gpt-45 are GPT-4.0/4.1/4.5,
    // non-reasoning), not just Azure's `gpt-35-turbo` alias.
    if (
        /^gpt-(?!3[0-9](\b|[-_@]))(?!4[0-9](\b|[-_@]))([6-9]|\d{2})(\b|[-_@])/.test(
            m,
        )
    ) {
        return { type: 'level', options: ['low', 'medium', 'high'] };
    }
    if (/^gpt-5(\b|[-_@])/.test(m)) {
        return { type: 'level', options: ['medium', 'high'] };
    }
    if (/^o[134](\b|[-_@])/.test(m) || /deep-research/.test(m)) {
        return { type: 'level', options: ['low', 'medium', 'high'] };
    }
    return undefined;
}
