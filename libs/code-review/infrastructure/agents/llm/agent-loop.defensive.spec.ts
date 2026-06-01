import {
    sanitizeFindingsResult,
    mergeFindings,
    type FindingsOutput,
} from './agent-loop';

describe('sanitizeFindingsResult', () => {
    it('returns null when given null', () => {
        expect(sanitizeFindingsResult(null)).toBeNull();
    });

    it('returns validated data for a valid FindingsOutput', () => {
        const valid: FindingsOutput = {
            reasoning: 'found a bug',
            suggestions: [
                {
                    relevantFile: 'src/foo.ts',
                    suggestionContent: 'Fix the null check',
                    existingCode: 'if (x)',
                    improvedCode: 'if (x != null)',
                },
            ],
        };
        const result = sanitizeFindingsResult(valid);
        expect(result).not.toBeNull();
        expect(result!.reasoning).toBe('found a bug');
        expect(result!.suggestions).toHaveLength(1);
        expect(result!.suggestions[0].relevantFile).toBe('src/foo.ts');
    });

    it('returns null when suggestions is missing entirely', () => {
        const malformed = { reasoning: 'some text' } as any;
        expect(sanitizeFindingsResult(malformed)).toBeNull();
    });

    it('returns null when suggestions is undefined', () => {
        const malformed = {
            reasoning: 'some text',
            suggestions: undefined,
        } as any;
        expect(sanitizeFindingsResult(malformed)).toBeNull();
    });

    it('returns null when suggestions is a string instead of array', () => {
        const malformed = {
            reasoning: 'some text',
            suggestions: 'not an array',
        } as any;
        expect(sanitizeFindingsResult(malformed)).toBeNull();
    });

    it('partially recovers when reasoning is missing but suggestions is a valid array', () => {
        const partial = {
            suggestions: [
                {
                    relevantFile: 'src/bar.ts',
                    suggestionContent: 'Fix this',
                    existingCode: 'old',
                    improvedCode: 'new',
                },
            ],
        } as any;
        const result = sanitizeFindingsResult(partial);
        expect(result).not.toBeNull();
        expect(result!.reasoning).toBe('');
        expect(result!.suggestions).toHaveLength(1);
    });

    it('returns validated data with empty suggestions array', () => {
        const empty: FindingsOutput = {
            reasoning: 'no issues found',
            suggestions: [],
        };
        const result = sanitizeFindingsResult(empty);
        expect(result).not.toBeNull();
        expect(result!.suggestions).toEqual([]);
    });
});

describe('mergeFindings', () => {
    it('merges two valid FindingsOutput objects', () => {
        const base: FindingsOutput = {
            reasoning: 'base reasoning',
            suggestions: [
                {
                    relevantFile: 'a.ts',
                    suggestionContent: 'fix a',
                    existingCode: 'old',
                    improvedCode: 'new',
                },
            ],
        };
        const extra: FindingsOutput = {
            reasoning: 'extra reasoning',
            suggestions: [
                {
                    relevantFile: 'b.ts',
                    suggestionContent: 'fix b',
                    existingCode: 'old',
                    improvedCode: 'new',
                },
            ],
        };
        const result = mergeFindings(base, extra);
        expect(result.suggestions).toHaveLength(2);
        expect(result.reasoning).toContain('base reasoning');
        expect(result.reasoning).toContain('extra reasoning');
    });

    it('does not throw when base.suggestions is undefined', () => {
        const base = { reasoning: 'base', suggestions: undefined } as any;
        const extra: FindingsOutput = {
            reasoning: 'extra',
            suggestions: [
                {
                    relevantFile: 'b.ts',
                    suggestionContent: 'fix b',
                    existingCode: 'old',
                    improvedCode: 'new',
                },
            ],
        };
        expect(() => mergeFindings(base, extra)).not.toThrow();
        const result = mergeFindings(base, extra);
        expect(result.suggestions).toHaveLength(1);
    });

    it('does not throw when extra.suggestions is undefined', () => {
        const base: FindingsOutput = {
            reasoning: 'base',
            suggestions: [
                {
                    relevantFile: 'a.ts',
                    suggestionContent: 'fix a',
                    existingCode: 'old',
                    improvedCode: 'new',
                },
            ],
        };
        const extra = { reasoning: 'extra', suggestions: undefined } as any;
        expect(() => mergeFindings(base, extra)).not.toThrow();
        const result = mergeFindings(base, extra);
        expect(result.suggestions).toHaveLength(1);
    });

    it('does not throw when both suggestions are undefined', () => {
        const base = { reasoning: 'base', suggestions: undefined } as any;
        const extra = { reasoning: 'extra', suggestions: undefined } as any;
        expect(() => mergeFindings(base, extra)).not.toThrow();
        const result = mergeFindings(base, extra);
        expect(result.suggestions).toEqual([]);
    });

    it('deduplicates suggestions with same file + lines + content', () => {
        const suggestion = {
            relevantFile: 'a.ts',
            relevantLinesStart: 10,
            relevantLinesEnd: 15,
            suggestionContent: 'fix a',
            existingCode: 'old',
            improvedCode: 'new',
        };
        const base: FindingsOutput = {
            reasoning: 'base',
            suggestions: [suggestion],
        };
        const extra: FindingsOutput = {
            reasoning: 'extra',
            suggestions: [{ ...suggestion }], // same content, different reference
        };
        const result = mergeFindings(base, extra);
        expect(result.suggestions).toHaveLength(1);
    });
});
