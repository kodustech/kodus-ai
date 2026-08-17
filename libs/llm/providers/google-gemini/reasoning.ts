import type { ReasoningConfig } from '../kernel/model-types';

/**
 * Gemini reasoning config — the Gemini family owner's answer. 3.x takes a
 * qualitative thinkingLevel (level); 2.5 (and the 2.0 thinking preview) take a
 * numeric thinkingBudget. The cross-host dispatcher (kernel/model-reasoning)
 * and this module's capabilities() both resolve through here.
 */
export function geminiReasoningConfig(
    model?: string,
): ReasoningConfig | undefined {
    if (!model) return undefined;
    const m = model.toLowerCase();
    if (/gemini-3/.test(m)) {
        return { type: 'level', options: ['low', 'medium', 'high'] };
    }
    if (/gemini-2\.5/.test(m) || /gemini-2\.0-.*thinking/.test(m)) {
        return { type: 'budget', options: { min: 128, default: 3000 } };
    }
    return undefined;
}
