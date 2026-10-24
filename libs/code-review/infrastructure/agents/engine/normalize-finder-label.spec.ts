import { normalizeFinderLabels } from './normalize-finder-label';

describe('normalizeFinderLabels', () => {
    it('replaces a label off the list with bug and keeps the suggestion', () => {
        const input = [
            { label: 'criticism', suggestionContent: 'a' },
            { label: 'info', suggestionContent: 'b' },
            { label: 'criticism', suggestionContent: 'c' },
        ];
        const out = normalizeFinderLabels(input);
        expect(out.suggestions.map((s) => s.label)).toEqual(['bug', 'bug', 'bug']);
        expect(out.suggestions.map((s) => s.suggestionContent)).toEqual(['a', 'b', 'c']);
        expect(out.replaced).toEqual({ criticism: 2, info: 1 });
    });

    it('keeps every valid label, whatever its case', () => {
        const out = normalizeFinderLabels([
            { label: 'bug' },
            { label: 'Security' },
            { label: ' performance ' },
            { label: 'kody_rules' },
            { label: 'repo_instruction' },
        ]);
        expect(out.suggestions.map((s) => s.label)).toEqual([
            'bug',
            'security',
            'performance',
            'kody_rules',
            'repo_instruction',
        ]);
        expect(out.replaced).toEqual({});
    });

    it('returns the same object when nothing changes', () => {
        const s = { label: 'bug' };
        expect(normalizeFinderLabels([s]).suggestions[0]).toBe(s);
    });

    it('treats a missing or non-string label as invalid', () => {
        const out = normalizeFinderLabels([{}, { label: 3 }]);
        expect(out.suggestions.map((s) => s.label)).toEqual(['bug', 'bug']);
    });

    it('discards a label the team turned off, after replacing an invalid one with bug', () => {
        const allowed = new Set(['security']);
        const out = normalizeFinderLabels(
            [
                { label: 'security' },
                { label: 'performance' },
                { label: 'criticism' },
                {},
            ],
            { allowed },
        );
        expect(out.suggestions.map((s) => s.label)).toEqual(['security']);
        expect(out.discarded.map((s) => s.label)).toEqual([
            'performance',
            'bug',
            'bug',
        ]);
    });

    it('keeps an exempt suggestion whatever the team turned off', () => {
        const out = normalizeFinderLabels(
            [{ label: 'kody_rules' }, { label: 'bug', customAgent: true }],
            {
                allowed: new Set(['security']),
                exempt: (s: any) => s.label === 'kody_rules' || !!s.customAgent,
            },
        );
        expect(out.suggestions).toHaveLength(2);
        expect(out.discarded).toEqual([]);
    });
});
