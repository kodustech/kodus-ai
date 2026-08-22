import type { ReasoningConfig } from '../kernel/model-types';

/** o-series and gpt-5 are OpenAI's reasoning families (level-based effort). Also
 *  gates `supportsTemperature` in the module (reasoners reject temperature). */
export function isOpenAiReasoner(model: string): boolean {
    return /^o[134](\b|[-_@])/i.test(model) || /^gpt-5(\b|[-_@])/i.test(model);
}

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
    if (/^gpt-5(\b|[-_@])/.test(m)) {
        return { type: 'level', options: ['medium', 'high'] };
    }
    if (/^o[134](\b|[-_@])/.test(m) || /deep-research/.test(m)) {
        return { type: 'level', options: ['low', 'medium', 'high'] };
    }
    return undefined;
}
