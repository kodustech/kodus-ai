jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn(() => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    })),
}));

import { createLogger } from '@libs/core/log/logger';
import {
    sanitizeFindingsResult,
    type FindingsOutput,
} from '@libs/code-review/infrastructure/agents/core/findings-schema';

// findings-schema.ts calls createLogger('FindingsSchema') exactly once at
// module load — this is that one instance, stable for the whole file.
const mockLogger = (createLogger as jest.Mock).mock.results[0].value;

describe('sanitizeFindingsResult', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
    });

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

    // Regression: prod audit (2026-09-17) of 619 [LLM_ENVELOPE] events found
    // ~150 were an otherwise-fully-valid suggestion dropped ONLY because the
    // model's self-reported `confidence` fell outside [1,10] (commonly 0).
    // `confidence` is telemetry, never trustworthy input (see review-finding.ts
    // doc comment) — an out-of-range value must not discard a real finding.
    it('keeps a suggestion whose self-reported confidence is 0 (out of the documented 1-10 range)', () => {
        const withZeroConfidence = {
            reasoning: 'found a bug',
            suggestions: [
                {
                    relevantFile: 'src/foo.ts',
                    suggestionContent: 'Fix the null check',
                    existingCode: 'if (x)',
                    improvedCode: 'if (x != null)',
                    confidence: 0,
                },
            ],
        } as any;
        const result = sanitizeFindingsResult(withZeroConfidence);
        expect(result).not.toBeNull();
        expect(result!.suggestions).toHaveLength(1);
        expect(result!.suggestions[0].confidence).toBe(0);
    });

    it('keeps a suggestion whose self-reported confidence exceeds 10', () => {
        const withOverConfidence = {
            reasoning: 'found a bug',
            suggestions: [
                {
                    relevantFile: 'src/foo.ts',
                    suggestionContent: 'Fix the null check',
                    existingCode: 'if (x)',
                    improvedCode: 'if (x != null)',
                    confidence: 42,
                },
            ],
        } as any;
        const result = sanitizeFindingsResult(withOverConfidence);
        expect(result).not.toBeNull();
        expect(result!.suggestions).toHaveLength(1);
    });

    // Backward compatibility: every test above calls sanitizeFindingsResult
    // with ONE argument (the pre-existing call shape, still used everywhere
    // this session didn't touch). None of them mock the logger and all still
    // pass, which already proves the added param breaks no existing caller.
    // This test makes that explicit and pins the no-crash contract too.
    it('still works when called with no telemetryMetadata at all (pre-existing call shape)', () => {
        const malformed = { reasoning: 'x', suggestions: 'not-an-array' } as any;
        let result: FindingsOutput | null = null;
        expect(() => {
            result = sanitizeFindingsResult(malformed);
        }).not.toThrow();
        expect(result).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn.mock.calls[0][0].metadata.organizationId).toBeUndefined();
    });

    // Regression (prod audit 2026-09-17): this file logged no organizationId
    // at all, so a bucket like "594 dropped-suggestion events" could never be
    // attributed to 1 org vs many. Both [LLM_ENVELOPE] warn call sites must
    // carry it end-to-end when the caller supplies it, and must not throw or
    // change behavior when the caller doesn't.
    describe('organizationId threading (observability only, zero behavior change)', () => {
        it('attaches organizationId to the schema-validation-failed warn', () => {
            const malformed = {
                reasoning: 'x',
                suggestions: 'not-an-array',
            } as any;

            const result = sanitizeFindingsResult(malformed, {
                organizationId: 'org-123',
            });

            expect(result).toBeNull(); // behavior unchanged
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            const [{ metadata }] = mockLogger.warn.mock.calls[0];
            expect(metadata.organizationId).toBe('org-123');
        });

        it('attaches organizationId to the dropped-suggestion warn, without changing which suggestions survive', () => {
            const mixed = {
                reasoning: 'x',
                suggestions: [
                    {
                        relevantFile: 'src/a.ts',
                        suggestionContent: 'ok',
                        existingCode: 'a',
                        improvedCode: 'b',
                    },
                    { totally: 'invalid' },
                ],
            } as any;

            const result = sanitizeFindingsResult(mixed, {
                organizationId: 'org-456',
            });

            expect(result!.suggestions).toHaveLength(1); // same as without metadata
            expect(mockLogger.warn).toHaveBeenCalledTimes(2); // schema-fail + dropped
            const droppedCall = mockLogger.warn.mock.calls[1][0];
            expect(droppedCall.metadata.organizationId).toBe('org-456');
            expect(droppedCall.metadata.dropped).toBe(1);
        });

        it('does not attach organizationId when the caller omits telemetryMetadata', () => {
            const malformed = {
                reasoning: 'x',
                suggestions: 'not-an-array',
            } as any;

            sanitizeFindingsResult(malformed);

            const [{ metadata }] = mockLogger.warn.mock.calls[0];
            expect(metadata.organizationId).toBeUndefined();
        });
    });
});
