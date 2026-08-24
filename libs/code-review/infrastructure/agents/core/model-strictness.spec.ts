import {
    supportsStrictTools,
    supportsStrictToolsForRun,
} from './model-strictness';

describe('supportsStrictTools', () => {
    it('enables strict only for Gemini', () => {
        expect(supportsStrictTools('gemini-3.7-flash')).toBe(true);
        expect(supportsStrictTools('gemini_2_flash')).toBe(true);
        expect(supportsStrictTools('gpt-5.6-luna')).toBe(false);
        expect(supportsStrictTools('claude-opus-4-8')).toBe(false);
        expect(supportsStrictTools(undefined)).toBe(false);
    });
});

describe('supportsStrictToolsForRun — accounts for the failover target', () => {
    it('keeps strict when primary is Gemini and there is no fallback', () => {
        expect(supportsStrictToolsForRun('gemini-3.7-flash')).toBe(true);
    });

    it('keeps strict when both primary and fallback are Gemini', () => {
        expect(
            supportsStrictToolsForRun('gemini-3.7-flash', 'gemini-2-flash'),
        ).toBe(true);
    });

    it('DISABLES strict when the fallback is non-strict (Gemini → OpenAI) — the bug', () => {
        // A strict tool built for Gemini would be rejected by the OpenAI fallback
        // ("Invalid schema for function ...", every property must be required).
        expect(
            supportsStrictToolsForRun('gemini-3.7-flash', 'gpt-5.6-luna'),
        ).toBe(false);
    });

    it('stays disabled when the primary itself is non-strict', () => {
        expect(supportsStrictToolsForRun('gpt-5.6-luna', 'gemini-3.7-flash')).toBe(
            false,
        );
        expect(supportsStrictToolsForRun('claude-opus-4-8')).toBe(false);
    });
});
