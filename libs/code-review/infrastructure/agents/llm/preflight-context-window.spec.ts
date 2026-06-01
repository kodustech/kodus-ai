import { assertPromptFitsInContext } from './agent-loop';
import { AgentPromptTooLargeError } from './errors';

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
        // 60_000 chars ≈ 15_000 tokens (chars / 4). Against a 12_288 window
        // with the 15% / 2048-token reserve, this must fail.
        const userPrompt = 'x'.repeat(60_000);
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
        const userPrompt = 'x'.repeat(60_000);
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
        const userPrompt = 'x'.repeat(60_000);
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
        const systemPrompt = 'x'.repeat(60_000);
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
