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
});
