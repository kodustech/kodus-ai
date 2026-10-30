import { LLM } from '@libs/llm/llm';
import {
    parseSeverityResponse,
    buildSeverityPrompt,
    DEFAULT_SEVERITY_FLAGS,
} from './severity-prompt';

// The prompt build + response parse live in severity-prompt (shared with the
// severity eval and tested there). Mock them so these tests pin classifySeverity's
// OWN job: input assembly (flags fallback, model threading) and fail-safe
// degradation — not the parsing.
jest.mock('./severity-prompt', () => ({
    DEFAULT_SEVERITY_FLAGS: { critical: true },
    buildSeverityPrompt: jest.fn(() => 'PROMPT'),
    parseSeverityResponse: jest.fn(),
}));

import { classifySeverity } from './classify-severity';

const parseMock = parseSeverityResponse as jest.Mock;
const buildMock = buildSeverityPrompt as jest.Mock;

/**
 * classifySeverity is a secondary pass: it must never take findings down with it.
 * On any failure (no model, a stuck call, an unparseable response) it degrades
 * to "everything medium" so the review still ships with a severity on each
 * suggestion, preserves partial responses, and routes the CLIENT's severity
 * criteria + BYOK model into the call.
 */
describe('classifySeverity — input assembly & fail-safe degradation', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks(); // isolate call history (jest.mock fns survive restoreAllMocks)
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue('llm text');
        parseMock.mockReturnValue({ classifications: new Map(), parseOk: true });
    });

    afterEach(() => jest.restoreAllMocks());

    it('returns an empty map WITHOUT calling the model when there are no suggestions', async () => {
        const out = await classifySeverity([]);
        expect(out.size).toBe(0);
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('defaults EVERY suggestion to medium when the response has no parseable JSON', async () => {
        parseMock.mockReturnValue({ classifications: new Map(), parseOk: false });

        const out = await classifySeverity([{}, {}, {}] as any);

        expect([...out.entries()]).toEqual([
            [0, 'medium'],
            [1, 'medium'],
            [2, 'medium'],
        ]);
    });

    it('is fail-safe: an LLM error degrades every suggestion to medium (never drops findings)', async () => {
        runSpy.mockRejectedValue(new Error('model timeout'));

        const out = await classifySeverity([{}, {}] as any);

        expect([...out.values()]).toEqual(['medium', 'medium']);
    });

    it('uses the client custom severity flags when provided', async () => {
        const custom = { critical: false, high: true };
        const suggestions = [{}] as any;

        await classifySeverity(suggestions, { severity: { flags: custom } } as any);

        expect(buildMock).toHaveBeenCalledWith(suggestions, custom);
    });

    it('falls back to DEFAULT_SEVERITY_FLAGS when no flags are configured', async () => {
        const suggestions = [{}] as any;

        await classifySeverity(suggestions, undefined);

        expect(buildMock).toHaveBeenCalledWith(suggestions, DEFAULT_SEVERITY_FLAGS);
    });

    it('threads the BYOK slot and the org id into the model call', async () => {
        const slot = { provider: 'openai', model: 'x' } as any;

        await classifySeverity([{}] as any, undefined, slot, 'org-9');

        expect(runSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                byokConfig: slot,
                organizationId: 'org-9',
                user: 'PROMPT',
            }),
        );
    });

    it('parses the model text, coalescing a missing response to "" (never passes null to the parser)', async () => {
        await classifySeverity([{}] as any);
        expect(parseMock).toHaveBeenCalledWith('llm text');

        runSpy.mockResolvedValue(undefined as any);
        await classifySeverity([{}] as any);
        expect(parseMock).toHaveBeenCalledWith(''); // null/undefined response → '' guard
    });
});

/**
 * ── LLM.run I/O CONTRACT MATRIX (envelope zoo, real parser) ──────────────────
 *
 * The block above mocks the parser to pin classifySeverity's OWN assembly. This
 * block runs the REAL parseSeverityResponse THROUGH classifySeverity so the
 * output-shape zoo (matrix A), semantic-but-wrong (B) and unparseable/transport
 * (C) rows are exercised end-to-end at the boundary's return contract.
 *
 * D for this boundary = Map<number, string> (suggestion index → severity). The
 * model returns FREE TEXT (LLM.run is called WITHOUT a schema); recovery is a
 * best-effort regex+JSON.parse over that text. The documented, observable
 * fail-safe for any non-recoverable text is "every suggestion → medium" plus a
 * logger.warn — so the review still ships a severity on each finding.
 *
 * Non-degradation contract (the #1786 invariant): for every off-schema row the
 * boundary must RECOVER the real payload OR degrade to the OBSERVABLE all-medium
 * fallback — never throw past the boundary, never silently ship a wrong value.
 */
const actualSeverityModule = jest.requireActual('./severity-prompt');
const realParse = actualSeverityModule.parseSeverityResponse;
const realBuild = actualSeverityModule.buildSeverityPrompt;

const ALLOWED_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const allMedium = (n: number) =>
    Array.from({ length: n }, () => 'medium');

describe('classifySeverity — LLM.run envelope contract (real parser)', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        runSpy = jest.spyOn(LLM, 'run');
        // Delegate the mocked module fns to the real implementations so the
        // envelope parse is genuinely exercised through classifySeverity.
        parseMock.mockImplementation((t: string) => realParse(t));
        buildMock.mockImplementation((s: any, f: any) => realBuild(s, f));
    });

    afterEach(() => jest.restoreAllMocks());

    // ── A. Output-shape zoo ─────────────────────────────────────────────────

    // Row 1 — exact D: valid classifications JSON recovers to the map.
    it('[row 1] recovers exact D — valid {classifications:[...]} → parsed map', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":[{"index":0,"severity":"high"},{"index":1,"severity":"low"}]}',
        );
        const out = await classifySeverity([{}, {}] as any);
        expect(out.get(0)).toBe('high');
        expect(out.get(1)).toBe('low');
    });

    // Row 2 — bare array (no classifications wrapper): the regex requires the
    // literal "classifications" key, so a bare array can't be recovered → the
    // observable all-medium fallback fires (documented, with a warn log).
    it('[row 2] bare array → observable all-medium fallback (no silent wrong ship)', async () => {
        runSpy.mockResolvedValue('[{"index":0,"severity":"high"}]');
        const out = await classifySeverity([{}, {}] as any);
        expect([...out.values()]).toEqual(allMedium(2));
    });

    // Row 3 — single object where an array is expected: for..of over an object
    // throws inside parse's try → parseOk false → all-medium fallback.
    it('[row 3] classifications as a single object (not array) → all-medium fallback', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":{"index":0,"severity":"high"}}',
        );
        const out = await classifySeverity([{}] as any);
        expect([...out.values()]).toEqual(allMedium(1));
    });

    // Row 7 — stringified JSON: the whole D delivered as a JSON string literal.
    // Boundary must return a valid Map (recover or fallback), never throw.
    it('[row 7] stringified-JSON envelope → returns a Map, never throws', async () => {
        runSpy.mockResolvedValue(
            JSON.stringify('{"classifications":[{"index":0,"severity":"high"}]}'),
        );
        const out = await classifySeverity([{}] as any);
        expect(out).toBeInstanceOf(Map);
        // whatever the outcome, in-range values stay within the allowed set
        for (const v of out.values()) expect(ALLOWED_SEVERITIES).toContain(v);
    });

    // Row 8 — markdown-fenced (the format the PROMPT actually requests): the
    // regex plucks the embedded JSON → recovers.
    it('[row 8] markdown-fenced ```json block → recovered', async () => {
        runSpy.mockResolvedValue(
            '```json\n{"classifications":[{"index":0,"severity":"critical"}]}\n```',
        );
        const out = await classifySeverity([{}] as any);
        expect(out.get(0)).toBe('critical');
    });

    // Row 9 — prose-wrapped JSON: embedded JSON is still extracted → recovers.
    it('[row 9] prose-wrapped JSON → recovered', async () => {
        runSpy.mockResolvedValue(
            'Here is the result: {"classifications":[{"index":0,"severity":"high"}]} Let me know!',
        );
        const out = await classifySeverity([{}] as any);
        expect(out.get(0)).toBe('high');
    });

    // Row 10 — right data, wrong inner keys (index→idx, severity→level): parse
    // requires numeric index + string severity, so nothing is set → all-medium
    // fallback rather than a silent wrong map.
    it('[row 10] right data / renamed inner keys → all-medium fallback', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":[{"idx":0,"level":"high"}]}',
        );
        const out = await classifySeverity([{}] as any);
        expect([...out.values()]).toEqual(allMedium(1));
    });

    // Row 11 — case/convention mismatch on the severity VALUE: parse lowercases,
    // so "HIGH" recovers as "high" (convention normalized).
    it('[row 11] severity value case mismatch ("HIGH") → normalized to "high"', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":[{"index":0,"severity":"HIGH"}]}',
        );
        const out = await classifySeverity([{}] as any);
        expect(out.get(0)).toBe('high');
    });

    // Row 12 — partial object: entries missing severity are skipped; complete
    // ones are kept (partial recovery, not all-or-nothing).
    it('[row 12] partial entries → keeps complete ones, skips incomplete', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":[{"index":0},{"index":1,"severity":"low"}]}',
        );
        const out = await classifySeverity([{}, {}] as any);
        expect(out.has(0)).toBe(false); // no severity → skipped (caller keeps agent value)
        expect(out.get(1)).toBe('low');
    });

    // Row 14 — empty object {}: no "classifications" → all-medium fallback.
    it('[row 14] empty object {} → all-medium fallback', async () => {
        runSpy.mockResolvedValue('{}');
        const out = await classifySeverity([{}, {}] as any);
        expect([...out.values()]).toEqual(allMedium(2));
    });

    // Row 15 — empty classifications array: parseOk is false (size 0) → all-medium.
    it('[row 15] empty classifications array → all-medium fallback', async () => {
        runSpy.mockResolvedValue('{"classifications":[]}');
        const out = await classifySeverity([{}, {}] as any);
        expect([...out.values()]).toEqual(allMedium(2));
    });

    // Row 17 — null / undefined return → coalesced to '' → all-medium fallback.
    it('[row 17] null response → all-medium fallback (no throw)', async () => {
        runSpy.mockResolvedValue(null as any);
        const out = await classifySeverity([{}] as any);
        expect([...out.values()]).toEqual(allMedium(1));
    });

    // ── B. Semantic-but-wrong ───────────────────────────────────────────────

    // Row 24 — enum out of the allowed set. KNOWN DEGRADATION (#1786 class):
    // parseSeverityResponse (severity-prompt.ts:92) accepts ANY string as the
    // severity with no enum validation and classify-severity.ts adds no
    // post-parse guard, so "URGENT" ships silently as "urgent" — a value the
    // rest of the pipeline never expects. The CORRECT behavior is to constrain
    // the value to the allowed set (drop it → caller keeps agent severity, or
    // default to medium). Pinned green-today / red-on-fix.
    it.failing(
        '[row 24] out-of-set severity should NOT ship as-is (enum guard) — KNOWN DEGRADATION',
        async () => {
            runSpy.mockResolvedValue(
                '{"classifications":[{"index":0,"severity":"URGENT"}]}',
            );
            const out = await classifySeverity([{}] as any);
            // when the fix lands, index 0 is either dropped or defaulted to a
            // valid severity — never the invalid "urgent".
            if (out.has(0)) {
                expect(ALLOWED_SEVERITIES).toContain(out.get(0));
            }
        },
    );

    // Row 25 — index out of range / dangling reference. The map may carry the
    // extra key, but the boundary is safe because the caller reads by POSITION
    // (severityMap.get(i) for i in range), so a dangling key can't misroute;
    // in-range indices stay correct.
    it('[row 25] out-of-range index → in-range value still correct, no throw', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":[{"index":0,"severity":"high"},{"index":99,"severity":"low"}]}',
        );
        const out = await classifySeverity([{}] as any); // only index 0 valid
        expect(out.get(0)).toBe('high');
        // caller iterates positions 0..len-1, so 99 is inert
        expect(out.get(1)).toBeUndefined();
    });

    // Row 26 — duplicate index entries: Map.set is last-wins, deterministically.
    it('[row 26] duplicate index entries → last-wins deterministically', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":[{"index":0,"severity":"high"},{"index":0,"severity":"low"}]}',
        );
        const out = await classifySeverity([{}] as any);
        expect(out.get(0)).toBe('low');
    });

    // ── C. Unparseable / transport (fail-safe layer) ────────────────────────

    // Row 28 — truncated JSON (max_tokens mid-object) → JSON.parse throws or no
    // match → all-medium fallback, never a crash.
    it('[row 28] truncated JSON → all-medium fallback', async () => {
        runSpy.mockResolvedValue(
            '{"classifications":[{"index":0,"severity":"hi',
        );
        const out = await classifySeverity([{}] as any);
        expect([...out.values()]).toEqual(allMedium(1));
    });

    // Row 31 — {error:...} object returned instead of a string: parse's .match
    // on a non-string throws → boundary catch → all-medium fallback.
    it('[row 31] {error} object returned → all-medium fallback', async () => {
        runSpy.mockResolvedValue({ error: 'rate_limited' } as any);
        const out = await classifySeverity([{}] as any);
        expect([...out.values()]).toEqual(allMedium(1));
    });

    // Row 33 — refusal prose ("I cannot help…") → no JSON → all-medium fallback.
    it('[row 33] refusal prose → all-medium fallback', async () => {
        runSpy.mockResolvedValue(
            "I'm sorry, but I can't help with classifying this content.",
        );
        const out = await classifySeverity([{}] as any);
        expect([...out.values()]).toEqual(allMedium(1));
    });
});

/**
 * ── D. Input variants (matrix row 37) ───────────────────────────────────
 *
 * classifySeverity sends ALL suggestions in ONE prompt (no batching), keys the
 * result by array POSITION, and reads only `suggestions.length` itself. So the
 * invariants here are: exactly one LLM.run call for any non-empty input, no
 * batch-boundary behavior, and clean pass-through of every input to the prompt
 * builder without throwing. Parser is mocked back to a happy stub so these pin
 * INPUT handling, not envelope parsing.
 */
describe('classifySeverity — input variants (D)', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        runSpy = jest.spyOn(LLM, 'run').mockResolvedValue('llm text');
        buildMock.mockImplementation(() => 'PROMPT');
        // happy parser: echo one classification per suggestion by position
        parseMock.mockReturnValue({ classifications: new Map(), parseOk: false });
    });

    afterEach(() => jest.restoreAllMocks());

    // Row 37 — large input crossing any token/batch boundary: NO batching here,
    // so still exactly ONE call carrying all N; fallback map covers all N.
    it('[row 37] large input → still ONE call, all N present in fallback', async () => {
        const big = Array.from({ length: 500 }, (_, i) => ({
            relevantFile: `f${i}.ts`,
            suggestionContent: `issue ${i}`,
        })) as any;
        const out = await classifySeverity(big);
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(out.size).toBe(500);
        expect(out.get(0)).toBe('medium');
        expect(out.get(499)).toBe('medium');
    });
});

/**
 * ── B. Semantic-but-wrong value encodings — rows 21-23 analog ────────────────
 *
 * Rows 21-23 (boolean encoded as "true"/"yes"/1) are strictly about a BOOLEAN
 * field in D (e.g. the verifier's `keep`). THIS boundary's D has no boolean:
 * the payload is {index:number, severity:string}. So 21-23 are recorded N/A.
 *
 * The closest applicable analog is a mis-TYPED severity value (number / boolean
 * instead of the enum string). parseSeverityResponse guards with
 * `typeof c.severity === 'string'` (severity-prompt.ts:92), so a non-string
 * severity is SKIPPED — the boundary then degrades observably to all-medium
 * rather than coercing a wrong value in. Pinned here so that guard can't regress
 * into a silent coercion (the #1786 class).
 */
describe('classifySeverity — mis-typed severity value (rows 21-23 analog)', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        runSpy = jest.spyOn(LLM, 'run');
        parseMock.mockImplementation((t: string) => realParse(t));
        buildMock.mockImplementation((s: any, f: any) => realBuild(s, f));
    });

    afterEach(() => jest.restoreAllMocks());

    it.each([
        ['severity as number (1)', '{"classifications":[{"index":0,"severity":1}]}'],
        ['index as string ("0")', '{"classifications":[{"index":"0","severity":"high"}]}'],
    ])(
        '[rows 21-23 analog] mis-typed entry (%s) is skipped → observable all-medium, never coerced',
        async (_label, text) => {
            runSpy.mockResolvedValue(text);
            const out = await classifySeverity([{}] as any);
            // the mis-typed entry never lands; the boundary degrades observably.
            expect([...out.values()]).toEqual(allMedium(1));
            for (const v of out.values()) expect(ALLOWED_SEVERITIES).toContain(v);
        },
    );
});
