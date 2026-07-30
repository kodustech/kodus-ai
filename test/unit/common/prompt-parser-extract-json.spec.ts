import { extractJsonFromResponse } from '@libs/common/utils/prompt-parser.utils';

// LLM output boundary: pins the parser against real-world model output
// shapes (prose preambles, code fences, non-array JSON, garbage) so a
// format drift degrades to null instead of crashing or mis-parsing —
// the same family as the '@kody conversation "Missing reasoning field"'
// incident (prose preamble mangled by whole-text repair).
describe('extractJsonFromResponse', () => {
    it('parses a plain JSON array', () => {
        expect(extractJsonFromResponse('[{"a":1}]')).toEqual([{ a: 1 }]);
    });

    it('parses arrays wrapped in markdown fences', () => {
        expect(extractJsonFromResponse('```json\n[{"a":1}]\n```')).toEqual([
            { a: 1 },
        ]);
        expect(extractJsonFromResponse('```\n[1,2]\n```')).toEqual([1, 2]);
    });

    it('parses an array preceded/followed by prose', () => {
        expect(
            extractJsonFromResponse(
                'Sure! Here are the references:\n[{"file":"x.ts"}]\nLet me know.',
            ),
        ).toEqual([{ file: 'x.ts' }]);
    });

    it('returns null for non-array JSON, prose-only and garbage', () => {
        expect(extractJsonFromResponse('{"a":1}')).toBeNull();
        expect(extractJsonFromResponse('no json here')).toBeNull();
        expect(extractJsonFromResponse('[broken')).toBeNull();
        expect(extractJsonFromResponse('')).toBeNull();
        expect(extractJsonFromResponse(null)).toBeNull();
        expect(extractJsonFromResponse(undefined)).toBeNull();
        expect(extractJsonFromResponse(42 as any)).toBeNull();
    });

    it('handles a JSON-stringified array (double-encoded)', () => {
        expect(extractJsonFromResponse('"[1,2,3]"')).toEqual([1, 2, 3]);
    });
});
