import { parseFinderSchema } from './parse-finder-schema';

const full = {
    label: 'bug',
    relevantFile: 'src/a.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    suggestionContent: 'the problem',
};

describe('parseFinderSchema', () => {
    it('requires file and lines for any label but kody_rules', () => {
        const r = parseFinderSchema([
            full,
            { ...full, relevantLinesStart: null, relevantLinesEnd: undefined },
            { ...full, label: 'invented-label', relevantFile: '' },
            { ...full, label: 'security' },
        ]);
        expect(r.discarded).toEqual([
            { index: 1, missing: ['relevantLinesStart', 'relevantLinesEnd'] },
            { index: 2, missing: ['relevantFile'] },
        ]);
    });

    it('lets a kody_rules suggestion go without file and lines (PR-level)', () => {
        const r = parseFinderSchema([{ label: 'kody_rules', suggestionContent: 'pr-level' }]);
        expect(r.discarded).toEqual([]);
    });

    it('always requires label and suggestionContent', () => {
        const r = parseFinderSchema([{ ...full, label: '' }, { ...full, suggestionContent: null }]);
        expect(r.discarded).toEqual([
            { index: 0, missing: ['label'] },
            { index: 1, missing: ['suggestionContent'] },
        ]);
    });
});
