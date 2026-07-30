import { sanitizeFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

const valid = {
    relevantFile: 'src/app.ts',
    suggestionContent: 'Fix the bug',
    existingCode: 'a()',
    improvedCode: 'b()',
};

// LLM output boundary: the schema declares required fields, but real model
// output violates it (kimi-k2.7 emitted suggestions without relevantFile on
// a customer instance, crashing the finder downstream). The sanitizer must
// never let an invalid item through — including in partial recovery.
describe('sanitizeFindingsResult', () => {
    it('passes through a fully valid payload', () => {
        const out = sanitizeFindingsResult({
            reasoning: 'ok',
            suggestions: [valid],
        } as any);
        expect(out?.suggestions).toHaveLength(1);
    });

    it('partial recovery drops items missing required fields (the kimi shape)', () => {
        const out = sanitizeFindingsResult({
            // top-level invalid (reasoning missing) → forces recovery path
            suggestions: [
                valid,
                { ...valid, relevantFile: undefined }, // no file
                { ...valid, suggestionContent: 42 }, // wrong type
                null,
            ],
        } as any);
        expect(out?.suggestions).toHaveLength(1);
        expect(out?.suggestions[0].relevantFile).toBe('src/app.ts');
    });

    it('recovery keeps zero items when all are invalid (empty, not crash)', () => {
        const out = sanitizeFindingsResult({
            suggestions: [{ foo: 'bar' }, null, 'text'],
        } as any);
        expect(out?.suggestions).toEqual([]);
    });

    it('returns null for null input and non-array suggestions', () => {
        expect(sanitizeFindingsResult(null)).toBeNull();
        expect(
            sanitizeFindingsResult({ suggestions: 'nope' } as any),
        ).toBeNull();
    });
});
