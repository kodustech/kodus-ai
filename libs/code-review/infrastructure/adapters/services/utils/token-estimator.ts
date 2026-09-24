import { estimateTextTokens } from '@libs/llm/token-estimate';

/**
 * Token estimation for the review pipeline.
 *
 * `estimateTokens` used to be `text.length / 3.5`, one of FIVE estimators in
 * this repo answering the same question with four different ratios. Measured
 * against `o200k_base` on this repo's own TypeScript, dense code runs ~4.2
 * chars/token, so 3.5 over-counted by 10-20% — and no single ratio can be right
 * anyway, because the same constant that is close on code is off by multiples on
 * other text (a run of 60,000 identical characters is ~7,500 tokens, not
 * 15,000). The tokenizer is right there, so it is used.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return estimateTextTokens(text);
}

/**
 * The REVERSE direction — tokens back to an approximate char budget — is the one
 * place a ratio is unavoidable: there is no text to measure yet. It stays
 * deliberately BELOW the measured ~4.2 so the conversion under-estimates how
 * many chars fit, which cuts a little more than necessary. The asymmetry is the
 * point: cutting slightly early costs a few characters of context, while cutting
 * late overflows the window and fails the call.
 */
const CONSERVATIVE_CHARS_PER_TOKEN = 3.5;

/** Convert token count back to approximate char count */
export function tokensToChars(tokens: number): number {
    return Math.floor(tokens * CONSERVATIVE_CHARS_PER_TOKEN);
}
