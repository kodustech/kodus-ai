/**
 * The preflight is the guard that decides whether a run is even attempted, and
 * it held the full prompt TEXT while estimating from `.length / 4` — it counted
 * characters and threw the strings away, with the real tokenizer sitting in the
 * same lib.
 *
 * Five estimators answer "how many tokens is this text" across the repo, with
 * four different ratios (tiktoken, chars/4, chars/3.5, bytes/4). Measured on this
 * repo's own TypeScript, dense code runs ~4.2 chars/token — so the flat-4 ones
 * are close and it is the "corrected" fallback of 3 that is furthest off. What
 * makes a flat ratio wrong is not its number, it is that no single number holds:
 * the same constant that is within 5% on code is off by multiples on other text.
 */
import { AgentPromptTooLargeError } from './errors';
import { assertPromptFitsInContext } from './preflight-context';
import { estimateTextTokens } from './token-estimate';

describe('the preflight measures instead of approximating', () => {
    it('uses the real tokenizer, not a flat chars/N ratio', () => {
        // Text where a flat ratio and the tokenizer disagree sharply: repeated
        // non-latin script tokenizes far worse than 4 chars/token, so a chars/4
        // guard would wave through a prompt the model cannot fit.
        const dense = '한국어테스트'.repeat(2_000);
        const flatFour = Math.ceil(dense.length / 4);
        const measured = estimateTextTokens(dense);

        expect(measured).toBeGreaterThan(flatFour);

        // A window sized just above the flat-4 estimate must still be refused,
        // which is only possible if the preflight measured.
        expect(() =>
            assertPromptFitsInContext({
                systemPrompt: '',
                userPrompt: dense,
                contextWindowTokens: flatFour + 2_048,
                modelName: 'probe',
            }),
        ).toThrow(AgentPromptTooLargeError);
    });

    it('still lets an ordinary prompt through', () => {
        expect(() =>
            assertPromptFitsInContext({
                systemPrompt: 'you are a reviewer',
                userPrompt: 'diff goes here',
                contextWindowTokens: 128_000,
                modelName: 'probe',
            }),
        ).not.toThrow();
    });

    it('does not enforce when the window is unknown', () => {
        expect(() =>
            assertPromptFitsInContext({
                systemPrompt: 'x'.repeat(1_000_000),
                userPrompt: '',
                contextWindowTokens: undefined,
                modelName: 'probe',
            }),
        ).not.toThrow();
    });
});
