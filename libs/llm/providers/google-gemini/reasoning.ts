import type { ReasoningConfig } from '../kernel/model-types';

/**
 * Gemini reasoning config — the Gemini family owner's answer. 3.x takes a
 * qualitative thinkingLevel (level); 2.5 (and the 2.0 thinking preview) take a
 * numeric thinkingBudget. The cross-host dispatcher (kernel/model-reasoning)
 * and this module's capabilities() both resolve through here.
 *
 * The two are NOT interchangeable — Google documents the parameters as
 * "completely incompatible", and sending both in one request is an error. The
 * per-model ranges below are the documented ones; a request outside them is
 * rejected, which is why `reasoning()` clamps instead of trusting a shared
 * effort→budget table (our `high` = 40,000 exceeded EVERY 2.5 ceiling).
 *
 * Sources: ai.google.dev/gemini-api/docs/thinking and
 * firebase.google.com/docs/ai-logic/thinking (per-model budget ranges).
 */

/** Documented thinkingBudget ranges for the 2.5 line. Order matters: the
 *  flash-lite pattern must be tried before the broader flash one. */
const BUDGET_RANGES: Array<
    [RegExp, { min: number; max: number; default: number }]
> = [
    [/gemini-2\.5-pro/, { min: 128, max: 32_768, default: 8_192 }],
    [/gemini-2\.5-flash-lite/, { min: 512, max: 24_576, default: 0 }],
    [/gemini-2\.5-flash/, { min: 1, max: 24_576, default: 8_192 }],
];

/** Levels each Gemini 3 model accepts. `gemini-3-pro-preview` is the outlier:
 *  it takes low and high ONLY, so a "medium" request is invalid there while its
 *  3.1 sibling accepts it. Our own scale never emits `minimal`, so it is omitted. */
const LEVELS: Array<[RegExp, Array<'low' | 'medium' | 'high'>]> = [
    [/gemini-3-pro-preview/, ['low', 'high']],
];
const DEFAULT_LEVELS: Array<'low' | 'medium' | 'high'> = [
    'low',
    'medium',
    'high',
];

export function geminiReasoningConfig(
    model?: string,
): ReasoningConfig | undefined {
    if (!model) return undefined;
    const m = model.toLowerCase();
    if (/gemini-3/.test(m)) {
        const entry = LEVELS.find(([re]) => re.test(m));
        return { type: 'level', options: entry ? entry[1] : DEFAULT_LEVELS };
    }

    // The 2.0 *thinking* preview is the only 2.0 that reasons; plain 2.0 (and
    // anything older) has no thinking at all and must not be sent a
    // thinkingConfig — falling through to `undefined` is what stops that.
    if (/gemini-2\.5/.test(m) || /gemini-2\.0-.*thinking/.test(m)) {
        const entry = BUDGET_RANGES.find(([re]) => re.test(m));
        return {
            type: 'budget',
            options: entry
                ? entry[1]
                : { min: 128, max: 24_576, default: 3_000 },
        };
    }
    return undefined;
}
