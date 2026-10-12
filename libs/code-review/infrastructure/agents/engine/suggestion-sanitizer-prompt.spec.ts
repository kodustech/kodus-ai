import {
    buildSanitizerPrompt,
    sanitizerDiscardIndices,
} from './suggestion-sanitizer-prompt';

describe('suggestion sanitizer', () => {
    it('lists every suggestion with its index, location and full text', () => {
        const p = buildSanitizerPrompt([
            { relevantFile: 'a.ts', relevantLinesStart: 1, relevantLinesEnd: 2, suggestionContent: 'first\nline two' },
            { relevantFile: 'b.ts', relevantLinesStart: 5, relevantLinesEnd: 5, suggestionContent: 'second' },
        ]);
        expect(p).toContain('[0] a.ts:1-2\nfirst\nline two');
        expect(p).toContain('[1] b.ts:5-5\nsecond');
        expect(p).toContain('An empty "discard" list is a normal answer');
    });

    it('keeps only valid, distinct indices', () => {
        expect(sanitizerDiscardIndices(3, { discard: [2, 0, 2, 7, -1, 1.5] })).toEqual([0, 2]);
        expect(sanitizerDiscardIndices(3, { discard: [] })).toEqual([]);
        expect(sanitizerDiscardIndices(3, {})).toEqual([]);
    });
});
