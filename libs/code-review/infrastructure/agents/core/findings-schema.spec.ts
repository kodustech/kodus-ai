import {
    sanitizeFindingsResult,
    type FindingsOutput,
} from '@libs/code-review/infrastructure/agents/core/findings-schema';

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
