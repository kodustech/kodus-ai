import { formatModelLabel } from './model-label';

describe('formatModelLabel', () => {
    it.each([
        ['kimi-k2.6', 'Kimi K2.6'],
        ['kimi-k2.7-code', 'Kimi K2.7 Code'],
        ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ['gemini-3-flash-preview', 'Gemini 3 Flash Preview'],
        ['glm-5.2', 'GLM 5.2'], // acronym → all caps
        ['glm-4.6', 'GLM 4.6'],
        ['gpt-5.4', 'GPT 5.4'], // acronym → all caps
        ['deepseek-v3', 'Deepseek V3'], // brand casing not derivable — override territory
        ['some-unknown-7b', 'Some Unknown 7b'],
    ])('%s → %s', (id, expected) => {
        expect(formatModelLabel(id)).toBe(expected);
    });

    it('takes the last segment of a deep-pathed id', () => {
        expect(formatModelLabel('accounts/fireworks/models/deepseek-v3')).toBe(
            'Deepseek V3',
        );
    });

    it('keeps version tokens verbatim (never turns 2.6 into 2 6)', () => {
        expect(formatModelLabel('kimi-k2.6')).not.toContain(' 6');
        expect(formatModelLabel('kimi-k2.6')).toContain('K2.6');
    });

    it('is a no-op on empty input', () => {
        expect(formatModelLabel('')).toBe('');
    });
});

// The picker no longer ships curated displayNames — every model name is derived
// from its id by `formatModelLabel`. These are the well-known brand ids whose
// derived label must stay faithful; if a future id stops matching, this fails and
// tells you to fix the id (or the formatter).
describe('well-known brand ids derive the intended label', () => {
    const DERIVED_IS_FAITHFUL: Array<[string, string]> = [
        ['kimi-k2.6', 'Kimi K2.6'],
        ['kimi-k2.7-code', 'Kimi K2.7 Code'],
        ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ['glm-5.2', 'GLM 5.2'],
    ];

    it.each(DERIVED_IS_FAITHFUL)(
        '%s is served as "%s" (from the id, no override)',
        (id, expected) => {
            expect(formatModelLabel(id)).toBe(expected);
        },
    );
});
