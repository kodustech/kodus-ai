import { extractJsonFromText } from './structured-output-repair';

/**
 * Differential / characterization test for the finder's extractor swap
 * (finder.agent `extractJsonBlock` → the shared `extractJsonFromText`). The
 * finder's fallback path parses findings out of the model's final TEXT, so this
 * is recall-sensitive: the swap must NEVER lose a case the old extractor parsed,
 * and should recover more. This pins that offline, before the F1 benchmark.
 */

// Verbatim copy of the finder's PRE-swap extractor — the reference behaviour.
function oldExtractJsonBlock(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) return fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return text.slice(start, end + 1);
    return null;
}

const tryParse = (s: string | null): unknown => {
    if (s == null) return undefined;
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
};

// Realistic finder final-text shapes.
const CORPUS: { name: string; text: string }[] = [
    { name: 'clean object', text: '{"reasoning":"r","suggestions":[]}' },
    {
        name: 'fenced object',
        text: '```json\n{"reasoning":"r","suggestions":[{"relevantFile":"a.ts"}]}\n```',
    },
    {
        name: 'bare object with leading prose',
        text: 'Here are my findings: {"reasoning":"r","suggestions":[]}',
    },
    {
        name: 'object then trailing prose that contains a brace',
        text: '{"reasoning":"r","suggestions":[]} (done — nothing else })',
    },
    { name: 'trailing comma', text: '{"reasoning":"r","suggestions":[],}' },
    {
        name: 'string value containing a brace, then trailing text',
        text: '{"reasoning":"has a } inside","suggestions":[]} thanks',
    },
    { name: 'no JSON at all', text: 'I could not find any issues.' },
    { name: 'empty', text: '' },
];

describe('finder extractor swap — differential vs the old extractJsonBlock', () => {
    it('never regresses: every input the OLD extractor parsed, the NEW one parses to the SAME value', () => {
        for (const { name, text } of CORPUS) {
            const oldParsed = tryParse(oldExtractJsonBlock(text));
            if (oldParsed === undefined) continue; // old couldn't parse — nothing to preserve
            const newParsed = tryParse(extractJsonFromText(text));
            expect({ name, newParsed }).toEqual({ name, newParsed: oldParsed });
        }
    });

    it('recovers cases the OLD extractor could NOT parse (strict gain)', () => {
        const gains = [
            {
                name: 'object + trailing prose with a brace',
                text: '{"reasoning":"r","suggestions":[]} (done — nothing else })',
                expected: { reasoning: 'r', suggestions: [] },
            },
            {
                name: 'trailing comma',
                text: '{"reasoning":"r","suggestions":[],}',
                expected: { reasoning: 'r', suggestions: [] },
            },
            {
                name: 'string brace AND a brace in the trailing prose (old over-grabs)',
                text: '{"reasoning":"a } b","suggestions":[]} see item {x}',
                expected: { reasoning: 'a } b', suggestions: [] },
            },
        ];
        for (const { name, text, expected } of gains) {
            // Precondition: the OLD extractor genuinely failed on this case.
            expect({ name, old: tryParse(oldExtractJsonBlock(text)) }).toEqual({
                name,
                old: undefined,
            });
            // The NEW extractor recovers it.
            expect({ name, next: tryParse(extractJsonFromText(text)) }).toEqual({
                name,
                next: expected,
            });
        }
    });

    it('agrees with the old extractor that non-JSON text yields nothing', () => {
        expect(tryParse(extractJsonFromText('no issues found'))).toBeUndefined();
        expect(tryParse(extractJsonFromText(''))).toBeUndefined();
    });
});
