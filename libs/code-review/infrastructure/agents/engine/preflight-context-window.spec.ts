import { assertPromptFitsInContext } from '@libs/llm/preflight-context';
import { AgentPromptTooLargeError } from '@libs/llm/errors';

/**
 * A prompt large enough to overflow the windows below.
 *
 * These cases used to say `BIG_PROMPT` with the note "60_000 chars ~
 * 15_000 tokens (chars / 4)". They are not: the preflight now measures with the
 * real tokenizer, and BPE folds a run of 60,000 identical characters into ~7,500
 * tokens — half the flat-ratio guess. That is the whole argument against a flat
 * chars/N estimate, demonstrated by the fixture the old test was built on.
 *
 * Varied text tokenizes the way real prompts do (~15,000 tokens for these 67,500
 * chars), so the intent of each case survives with a fixture that means what it
 * says.
 */
const BIG_PROMPT = 'the quick brown fox jumps over the lazy dog; '.repeat(1_500);

describe('assertPromptFitsInContext', () => {
    it('does not throw when prompt is well below contextWindow', () => {
        expect(() =>
            assertPromptFitsInContext({
                systemPrompt: 'short system',
                userPrompt: 'short user',
                contextWindowTokens: 128_000,
                modelName: 'gemini-2.5-pro',
            }),
        ).not.toThrow();
    });

    it('throws AgentPromptTooLargeError when (prompt + output reserve) exceeds contextWindow', () => {
        // ~15_000 measured tokens against a 12_288 window, with the 15% /
        // 2048-token reserve on top: this must fail.
        const userPrompt = BIG_PROMPT;
        expect(() =>
            assertPromptFitsInContext({
                systemPrompt: '',
                userPrompt,
                contextWindowTokens: 12_288,
                modelName: 'meta-llama/Llama-3.3-70B-Instruct',
            }),
        ).toThrow(AgentPromptTooLargeError);
    });

    it('error carries estimatedTokens and contextWindowTokens for telemetry', () => {
        const userPrompt = BIG_PROMPT;
        try {
            assertPromptFitsInContext({
                systemPrompt: '',
                userPrompt,
                contextWindowTokens: 12_288,
                modelName: 'llama',
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(AgentPromptTooLargeError);
            const err = e as AgentPromptTooLargeError;
            expect(err.estimatedTokens).toBeGreaterThan(12_288);
            expect(err.contextWindowTokens).toBe(12_288);
            expect(err.modelName).toBe('llama');
        }
    });

    it('does NOT throw when contextWindowTokens is undefined (no info to enforce)', () => {
        const userPrompt = BIG_PROMPT;
        expect(() =>
            assertPromptFitsInContext({
                systemPrompt: '',
                userPrompt,
                contextWindowTokens: undefined,
                modelName: 'unknown',
            }),
        ).not.toThrow();
    });

    it('accounts for systemPrompt size too, not just userPrompt', () => {
        const systemPrompt = BIG_PROMPT;
        expect(() =>
            assertPromptFitsInContext({
                systemPrompt,
                userPrompt: 'tiny',
                contextWindowTokens: 12_288,
                modelName: 'llama',
            }),
        ).toThrow(AgentPromptTooLargeError);
    });
});
