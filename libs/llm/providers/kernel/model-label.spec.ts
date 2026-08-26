import { formatModelLabel } from './model-label';
import { REGISTRY } from '../index';
import { resolveCatalogFrom } from './catalog';

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

// The load-bearing guarantee behind dropping curated displayNames: for the ids
// whose override we removed, the derived label MUST reproduce the old label — so
// the change is invisible on screen. If a future id stops matching, this fails
// and tells you to either keep an override or fix the id.
describe('curated entries with no displayName derive the intended label', () => {
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

    it('every catalog entry resolves to a non-empty displayName (override or derived)', () => {
        const catalog = resolveCatalogFrom(REGISTRY.all());
        expect(catalog.length).toBeGreaterThan(0);
        for (const m of catalog) {
            expect(m.displayName?.length ?? 0).toBeGreaterThan(0);
        }
    });
});
