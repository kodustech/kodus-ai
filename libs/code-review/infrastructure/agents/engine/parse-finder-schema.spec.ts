import { parseFinderSchema } from './parse-finder-schema';

const full = {
    label: 'bug',
    relevantFile: 'src/a.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    suggestionContent: 'the problem',
};

describe('parseFinderSchema', () => {
    it('keeps the five lean fields and llmPrompt, removing everything else', () => {
        const r = parseFinderSchema([
            {
                ...full,
                llmPrompt: 'the problem',
                existingCode: '',
                improvedCode: '',
                producedBy: 'generalist-base',
                severity: 'high',
            },
        ]);
        expect(r.suggestions).toEqual([{ ...full, llmPrompt: 'the problem' }]);
        expect(r.discarded).toEqual([]);
        expect(r.removedFields).toEqual({
            existingCode: 1,
            improvedCode: 1,
            producedBy: 1,
            severity: 1,
        });
    });

    it('requires file and lines for any label but kody_rules', () => {
        const r = parseFinderSchema([
            full,
            { ...full, relevantLinesStart: null, relevantLinesEnd: undefined },
            { ...full, label: 'invented-label', relevantFile: '' },
            { ...full, label: 'security' },
        ]);
        expect(r.suggestions).toEqual([full, { ...full, label: 'security' }]);
        expect(r.discarded).toEqual([
            { index: 1, missing: ['relevantLinesStart', 'relevantLinesEnd'] },
            { index: 2, missing: ['relevantFile'] },
        ]);
    });

    it('lets a kody_rules suggestion go without file and lines (PR-level)', () => {
        const r = parseFinderSchema([{ label: 'kody_rules', suggestionContent: 'pr-level' }]);
        expect(r.suggestions).toEqual([{ label: 'kody_rules', suggestionContent: 'pr-level' }]);
    });

    it('always requires label and suggestionContent', () => {
        const r = parseFinderSchema([{ ...full, label: '' }, { ...full, suggestionContent: null }]);
        expect(r.suggestions).toEqual([]);
        expect(r.discarded).toEqual([
            { index: 0, missing: ['label'] },
            { index: 1, missing: ['suggestionContent'] },
        ]);
    });
});
