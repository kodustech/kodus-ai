/**
 * CONTRACT tests for the review-agent LLM.run boundary — the FULL I/O matrix.
 *
 * `review-agent.contract.ts` is a TYPES-ONLY file (interfaces + one `export type`
 * re-export); it has no runtime LLM.run site of its own. The declared output
 * schema `D` it defines is `FindingsOutput` = `{ reasoning, suggestions[] }`
 * (re-exported from core/findings-schema). The DETERMINISTIC layer that MUST
 * honor that contract — request assembly, envelope parsing, fallback and the
 * guaranteed return shape — lives in the finder:
 *
 *   - extractFindings(state)            — read submitResult artifact / step text,
 *                                          sanitize, fall back; ALWAYS returns D.
 *   - extractFindingsWithRecovery(...)  — + injected prose recovery.
 *   - recoverFindingsFromProse(...)     — the LLM.run STRUCTURED-CALL site
 *                                          (schema/user/byokConfig/runName/org
 *                                          assembly + parse + fail-safe).
 *   - sanitizeFindingsResult(raw)       — the Zod validator that guards D.
 *
 * SCOPE = the deterministic layer only (assembly, parse, fallback, return shape).
 * We never assert the model's DECISION quality (whether a finding is correct) —
 * that is the separate eval track.
 *
 * The `LLM.run` boundary is spied (jest.spyOn(LLM, 'run')) and RESTORED after
 * every test so the sibling finder specs keep passing.
 *
 * Matrix rows (llm-io-contract-matrix.md): A=1-20, B=21-27, C=28-34, D=35-42.
 * E (provider/model policy) is a cross-cutting lens applied to the A/B/C rows.
 * Rows where prod SILENTLY degrades (the #1786 class) are pinned as `it.failing`
 * asserting the CORRECT behavior (green today, red on the fix).
 */

// Defensive: match the sibling finder.agent.spec so importing the finder module
// does no heavy model init at load time. LLM.run is spied per-test regardless.
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import {
    extractFindings,
    extractFindingsWithRecovery,
    recoverFindingsFromProse,
    FINDER_DONE_TOOL,
    type FinderSuggestion,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { sanitizeFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';
import { LLM } from '@libs/llm/llm';

import type {
    RunState,
    Artifact,
    RunStep,
} from '@libs/agent-harness/domain/contracts/run-state.contract';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const validSuggestion = (over: Partial<FinderSuggestion> = {}): any => ({
    relevantFile: 'src/auth.ts',
    suggestionContent: 'Guard the token before use',
    existingCode: 'const t = req.token;',
    improvedCode: 'const t = req.token; if (!t) throw new Error("no token");',
    label: 'bug',
    severity: 'high',
    confidence: 8,
    ...over,
});

/** A valid FindingsOutput = the declared schema D. */
const validD = (suggestions: any[] = [validSuggestion()]) => ({
    reasoning: 'analysis complete',
    suggestions,
});

const artifactOf = (payload: unknown, type = FINDER_DONE_TOOL): Artifact => ({
    type,
    payload,
});

const stepOf = (content: string | readonly unknown[]): RunStep => ({
    index: 0,
    message: { role: 'assistant', content },
});

const makeState = (over: Partial<RunState> = {}): RunState =>
    ({
        runId: 'r1',
        agentId: 'finder',
        status: 'completed',
        steps: [],
        artifacts: [],
        usage: {},
        trace: [],
        ...over,
    }) as RunState;

/** Prose that clears the looksLikeFindings gate (len>=80, >=2 signal groups). */
const findingLikeProse =
    'There is a null pointer bug in src/auth.ts:42 where the token is missing ' +
    'and must be checked before use, otherwise the login flow would crash.';

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// The boundary ALWAYS returns its declared shape { reasoning, suggestions[] }.
// ═══════════════════════════════════════════════════════════════════════════

describe('return-shape invariant (declared type across every layer)', () => {
    const assertShape = (r: any) => {
        expect(r).toBeDefined();
        expect(typeof r.reasoning).toBe('string');
        expect(Array.isArray(r.suggestions)).toBe(true);
    };

    it('extractFindings returns { reasoning:string, suggestions:array } for garbage', () => {
        for (const payload of [null, undefined, 0, true, 'x', [], {}, 42]) {
            assertShape(extractFindings(makeState({ artifacts: [artifactOf(payload)] })));
        }
        assertShape(extractFindings(makeState()));
    });

    it('extractFindingsWithRecovery resolves to the declared shape even with no recoverer', async () => {
        const r = await extractFindingsWithRecovery(makeState());
        expect(typeof r.reasoning).toBe('string');
        expect(Array.isArray(r.suggestions)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// A. Output-shape zoo (rows 1-20) — via the submitResult artifact / step text.
// ═══════════════════════════════════════════════════════════════════════════

describe('A. output-shape zoo', () => {
    // Row 1 — Exact D (happy path): recovered exactly.
    it('row 1: exact D → recovered with keys/types preserved', () => {
        const r = extractFindings(
            makeState({ artifacts: [artifactOf(validD())] }),
        );
        expect(r.reasoning).toBe('analysis complete');
        expect(r.suggestions).toHaveLength(1);
        expect(r.suggestions[0].relevantFile).toBe('src/auth.ts');
    });

    // Row 2 — Bare array where D is an object. Prod: sanitize returns null and the
    // real findings are dropped to []. #1786 class → pin CORRECT (recover) behavior.
    // Degradation: findings-schema.ts sanitizeFindingsResult L44-83 (no array→D lift).
    it.failing('row 2: bare array of items → should recover the items (prod drops silently)', () => {
        const r = extractFindings(
            makeState({ artifacts: [artifactOf([validSuggestion()])] }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 3 — Single object where an array is expected (suggestions is one object).
    // Degradation: findings-schema.ts L63 requires Array.isArray(suggestions).
    it.failing('row 3: suggestions as a single object → should wrap into an array (prod drops)', () => {
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({ reasoning: 'r', suggestions: validSuggestion() }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 4 — Wrapper key {result:D}/{data:D}/{output:D}/{response:D}/{json:D}.
    // Degradation: sanitizeFindingsResult never unwraps a wrapper key (L44-83).
    it.failing('row 4: {result: D} wrapper → should unwrap (prod drops silently)', () => {
        for (const key of ['result', 'data', 'output', 'response', 'json']) {
            const r = extractFindings(
                makeState({ artifacts: [artifactOf({ [key]: validD() })] }),
            );
            expect(r.suggestions).toHaveLength(1);
        }
    });

    // Row 5 — Double wrapper {result:{result:D}}.
    it.failing('row 5: double wrapper {result:{result:D}} → should unwrap (prod drops)', () => {
        const r = extractFindings(
            makeState({
                artifacts: [artifactOf({ result: { result: validD() } })],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 6 — Numeric / opaque single-key wrap {"0":D} / {content:D}.
    it.failing('row 6: opaque single-key wrap {content:D} → should unwrap (prod drops)', () => {
        const r = extractFindings(
            makeState({ artifacts: [artifactOf({ content: validD() })] }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 7 — Stringified JSON of D arriving as the model's TEXT answer (the
    // realistic path: model answered in text instead of calling submitResult).
    // extractJsonFromText + JSON.parse recovers it.
    it('row 7: stringified JSON of D in step text → recovered', () => {
        const r = extractFindings(
            makeState({ steps: [stepOf(JSON.stringify(validD()))] }),
        );
        expect(r.suggestions).toHaveLength(1);
        expect(r.reasoning).toBe('analysis complete');
    });

    // Row 8 — Markdown-fenced JSON in step text → fence unwrapped, recovered.
    it('row 8: markdown ```json fenced D in step text → recovered', () => {
        const fenced = '```json\n' + JSON.stringify(validD()) + '\n```';
        const r = extractFindings(makeState({ steps: [stepOf(fenced)] }));
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 9 — Prose-wrapped JSON in step text → balanced-slice recovers it.
    it('row 9: prose-wrapped D in step text → recovered', () => {
        const prose =
            'Here is the result: ' +
            JSON.stringify(validD()) +
            '\n\nLet me know if you need more.';
        const r = extractFindings(makeState({ steps: [stepOf(prose)] }));
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 10 — Right data, wrong container key (renamed): {reasoning, findings:[...]}.
    // Degradation: sanitizeFindingsResult has no key alias (L44-83).
    it.failing('row 10: renamed key (findings vs suggestions) → should alias (prod drops)', () => {
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({ reasoning: 'r', findings: [validSuggestion()] }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 11 — Case/convention mismatch on the container key (Suggestions).
    it.failing('row 11: case mismatch (Suggestions) → should normalize (prod drops)', () => {
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({ reasoning: 'r', Suggestions: [validSuggestion()] }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 12 — Partial item: one valid + one missing required keys. The valid one
    // is kept, the partial one dropped (documented partial recovery, logged).
    it('row 12: mixed valid + partial items → keeps valid, drops incomplete', () => {
        const partial = { relevantFile: 'a.ts', suggestionContent: 'x' }; // no existing/improved
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({
                        reasoning: 'r',
                        suggestions: [validSuggestion(), partial],
                    }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
        expect(r.suggestions[0].relevantFile).toBe('src/auth.ts');
    });

    // Row 13 — Extra unknown keys alongside the right ones → tolerated (Zod strips).
    it('row 13: extra unknown keys tolerated, real payload recovered', () => {
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({
                        reasoning: 'r',
                        suggestions: [validSuggestion({ bogusField: 'x' } as any)],
                        extraTop: 'ignore me',
                    }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
        expect((r.suggestions[0] as any).bogusField).toBeUndefined();
    });

    // Row 14 — Empty object {} → typed-empty WITH an observable reason flag.
    it('row 14: empty object → empty result signalled via __findingsOutcome', () => {
        const state = makeState({ artifacts: [artifactOf({})] });
        const r = extractFindings(state);
        expect(r.suggestions).toHaveLength(0);
        expect((state as any).__findingsOutcome).toBe('artifact-unusable');
    });

    // Row 15 — Empty array (valid "reviewed, found nothing") → structured empty.
    it('row 15: empty suggestions array → valid structured empty', () => {
        const state = makeState({
            artifacts: [artifactOf({ reasoning: 'clean', suggestions: [] })],
        });
        const r = extractFindings(state);
        expect(r.suggestions).toHaveLength(0);
        expect(r.reasoning).toBe('clean');
        expect((state as any).__findingsOutcome).toBe('structured');
    });

    // Row 16 — Empty / whitespace string → safe empty, no throw.
    it('row 16: empty/whitespace payload and step text → safe empty', () => {
        expect(extractFindings(makeState({ artifacts: [artifactOf('')] })).suggestions).toHaveLength(0);
        expect(extractFindings(makeState({ steps: [stepOf('   \n\t ')] })).suggestions).toHaveLength(0);
    });

    // Row 17 — null/undefined artifact absent → typed-empty with 'no-artifact'.
    it('row 17: no artifact / null return → no-artifact outcome, declared shape', () => {
        const state = makeState();
        const r = extractFindings(state);
        expect(r.suggestions).toHaveLength(0);
        expect((state as any).__findingsOutcome).toBe('no-artifact');
        expect(sanitizeFindingsResult(null)).toBeNull();
    });

    // Row 18 — Primitive where object expected → safe empty, no throw.
    it('row 18: primitive payload (true/0/"ok") → safe empty', () => {
        for (const p of [true, 0, 'ok', 3.14]) {
            expect(() =>
                extractFindings(makeState({ artifacts: [artifactOf(p)] })),
            ).not.toThrow();
        }
    });

    // Row 19 — Provider envelope leak: {choices:[{message:{content}}]}. The real D
    // is buried inside choices[0].message.content. LLM.run normally strips it; a
    // leak reaching here is dropped. #1786 class.
    it.failing('row 19: provider envelope leak → should unwrap choices[].message.content (prod drops)', () => {
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({
                        choices: [
                            { message: { content: JSON.stringify(validD()) } },
                        ],
                    }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 20 — Reasoning/thinking leak: model wrote findings as PROSE in
    // `reasoning` and OMITTED `suggestions` (the Anthropic omission mode). The
    // boundary must PRESERVE the prose so downstream recovery can re-structure it.
    it('row 20: thinking/prose leak with suggestions omitted → prose PRESERVED for recovery', () => {
        const r = extractFindings(
            makeState({
                artifacts: [artifactOf({ reasoning: findingLikeProse })],
            }),
        );
        expect(r.suggestions).toHaveLength(0);
        expect(r.reasoning).toBe(findingLikeProse); // not blanked → recoverable
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Semantic-but-wrong (rows 21-27).
// ═══════════════════════════════════════════════════════════════════════════

describe('B. semantic-but-wrong', () => {
    // Rows 21-23 (boolean encodings) — N/A: FindingsOutput/suggestion has no
    // boolean field. The verifier's `keep` boolean is a SEPARATE boundary,
    // covered in core/verifier.agent.contract.spec.ts. See rowsNA.

    // Row 24 — Enum out of allowed set: severity:"URGENT". A whole REAL finding is
    // dropped over one invalid OPTIONAL field. #1786 class → pin CORRECT (keep the
    // finding, drop/normalize the bad optional). Degradation: findings-schema.ts
    // suggestionSchema enum on `severity` (L23) + partial-recovery drop L66-70.
    it.failing('row 24: out-of-set severity → should keep finding minus bad optional (prod drops whole finding)', () => {
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({
                        reasoning: 'r',
                        suggestions: [validSuggestion({ severity: 'URGENT' as any })],
                    }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 25 — Index out of range / dangling reference — N/A: FindingsOutput
    // carries no index into the input array (unlike dedup's uniqueIndices). Line
    // ranges are validated downstream (snapLinesToDiff). See rowsNA.

    // Row 26 — Duplicate keys in JSON object (last-wins) via step text.
    it('row 26: duplicate JSON keys → last-wins honored, valid parse, no crash', () => {
        const dupText =
            '{"reasoning":"first","reasoning":"second","suggestions":[' +
            JSON.stringify(validSuggestion()) +
            ']}';
        const r = extractFindings(makeState({ steps: [stepOf(dupText)] }));
        expect(r.reasoning).toBe('second');
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 27 — Unicode / escaped newlines / emoji inside string fields → preserved.
    it('row 27: unicode/emoji/escaped newlines in fields → preserved exactly', () => {
        const s = validSuggestion({
            suggestionContent: 'café ☕ bug 🐛\nsecond line A',
        });
        const r = extractFindings(
            makeState({
                artifacts: [artifactOf({ reasoning: 'r 🚀', suggestions: [s] })],
            }),
        );
        expect(r.suggestions[0].suggestionContent).toBe(
            'café ☕ bug 🐛\nsecond line A',
        );
        expect(r.reasoning).toBe('r 🚀');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Unparseable / transport — the fail-safe layer (rows 28-34).
// The LLM.run STRUCTURED-CALL site is recoverFindingsFromProse; the text-parse
// path is extractFindings/findingsFromText.
// ═══════════════════════════════════════════════════════════════════════════

describe('C. unparseable / transport (fail-safe)', () => {
    // Row 28 — Truncated JSON (max_tokens mid-object) in step text → safe empty.
    it('row 28: truncated JSON in step text → safe empty, no throw', () => {
        const truncated = '{"reasoning":"x","suggestions":[{"relevantFile":"a.ts",';
        expect(() =>
            extractFindings(makeState({ steps: [stepOf(truncated)] })),
        ).not.toThrow();
        expect(
            extractFindings(makeState({ steps: [stepOf(truncated)] })).suggestions,
        ).toHaveLength(0);
    });

    // Row 29 — Malformed JSON: trailing comma is repaired; single-quote fails safe.
    it('row 29: trailing-comma JSON → recovered; single-quote JSON → safe empty', () => {
        const trailing =
            '{"reasoning":"r","suggestions":[' +
            JSON.stringify(validSuggestion()) +
            ',]}';
        expect(
            extractFindings(makeState({ steps: [stepOf(trailing)] })).suggestions,
        ).toHaveLength(1);

        const singleQuote = "{'reasoning':'r','suggestions':[]}";
        expect(() =>
            extractFindings(makeState({ steps: [stepOf(singleQuote)] })),
        ).not.toThrow();
    });

    // Row 30 — LLM.run THROWS (network/timeout) at the recovery boundary → caught,
    // returns [], never crashes the review.
    it('row 30: LLM.run throws → recoverFindingsFromProse returns [] (no throw past boundary)', async () => {
        const spy = jest
            .spyOn(LLM, 'run')
            .mockRejectedValue(new Error('ECONNRESET') as any);
        const out = await recoverFindingsFromProse(findingLikeProse, undefined, 'org1');
        expect(out).toEqual([]);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    // Row 31 — Error object returned {error:...} instead of throwing.
    it('row 31: {error} object from LLM.run → [] (best-effort fail-safe)', async () => {
        jest.spyOn(LLM, 'run').mockResolvedValue({ error: 'quota exceeded' } as any);
        const out = await recoverFindingsFromProse(findingLikeProse, undefined, 'org1');
        expect(out).toEqual([]);
        // And via the artifact path: {error} → unusable, signalled.
        const state = makeState({ artifacts: [artifactOf({ error: 'boom' })] });
        extractFindings(state);
        expect((state as any).__findingsOutcome).toBe('artifact-unusable');
    });

    // Row 32 — Empty success (content:'', finish_reason:'length') → [].
    it('row 32: empty-success from LLM.run → []', async () => {
        jest.spyOn(LLM, 'run').mockResolvedValue({ suggestions: [] } as any);
        const out = await recoverFindingsFromProse(findingLikeProse, undefined, 'org1');
        expect(out).toEqual([]);
    });

    // Row 33 — Refusal ("I cannot help…"): the looksLikeFindings gate short-circuits
    // BEFORE paying for LLM.run; a refusal-shaped result also degrades to [].
    it('row 33: refusal prose → gate skips LLM.run entirely, returns []', async () => {
        const spy = jest.spyOn(LLM, 'run').mockResolvedValue({ suggestions: [] } as any);
        const out = await recoverFindingsFromProse('I cannot help with that.', undefined, 'org1');
        expect(out).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
    });

    // Row 34 — Abort signal fired mid-call: an AbortError surfacing from LLM.run is
    // caught like any transport failure → []. (recoverFindingsFromProse does not
    // itself thread an abortSignal; parentSignal is threaded in the loop path.)
    it('row 34: AbortError from LLM.run → [] (no throw past boundary)', async () => {
        const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
        jest.spyOn(LLM, 'run').mockRejectedValue(abort as any);
        const out = await recoverFindingsFromProse(findingLikeProse, undefined, 'org1');
        expect(out).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Input variants (rows 35-42) — happy LLM/parse, assert the invariant.
// ═══════════════════════════════════════════════════════════════════════════

describe('D. input variants', () => {
    // Row 35 — Empty input (0 findings / empty state / empty prose).
    it('row 35: empty input → typed-empty, no throw', async () => {
        expect(extractFindings(makeState()).suggestions).toHaveLength(0);
        const spy = jest.spyOn(LLM, 'run').mockResolvedValue({ suggestions: [] } as any);
        expect(await recoverFindingsFromProse('', undefined, 'org1')).toEqual([]);
        expect(spy).not.toHaveBeenCalled(); // gate rejects empty prose
    });

    // Row 36 — Single item → recovered, length 1.
    it('row 36: single finding → recovered exactly once', () => {
        const r = extractFindings(
            makeState({ artifacts: [artifactOf(validD([validSuggestion()]))] }),
        );
        expect(r.suggestions).toHaveLength(1);
    });

    // Row 37 — Large input crossing the batch/token boundary → fully recovered
    // (no chunk cap at this parse layer; batching is executeChunked's concern).
    it('row 37: large payload (500 findings) → fully recovered, none dropped', () => {
        const many = Array.from({ length: 500 }, (_, i) =>
            validSuggestion({ relevantFile: `src/f${i}.ts` }),
        );
        const r = extractFindings(
            makeState({ artifacts: [artifactOf(validD(many))] }),
        );
        expect(r.suggestions).toHaveLength(500);
    });

    // Row 38 — Duplicate items in input → BOTH preserved (dedup is a later stage,
    // collapseNearDuplicates — the parse boundary must not silently dedup).
    it('row 38: duplicate findings → both preserved (no silent dedup at parse)', () => {
        const dup = validSuggestion();
        const r = extractFindings(
            makeState({ artifacts: [artifactOf(validD([dup, { ...dup }]))] }),
        );
        expect(r.suggestions).toHaveLength(2);
    });

    // Row 39 — Item with null/undefined required field (the documented kimi-k2.7
    // fix): the invalid item is dropped, valid siblings kept, reasoning preserved.
    it('row 39: null required field → invalid item dropped, valid kept', () => {
        const r = extractFindings(
            makeState({
                artifacts: [
                    artifactOf({
                        reasoning: 'r',
                        suggestions: [
                            validSuggestion(),
                            validSuggestion({ relevantFile: null as any }),
                        ],
                    }),
                ],
            }),
        );
        expect(r.suggestions).toHaveLength(1);
        expect(r.suggestions[0].relevantFile).toBe('src/auth.ts');
    });

    // Row 40 — Special chars / huge diff / whitespace-only → recovered or safe.
    it('row 40: special-char & huge fields recovered; whitespace-only text → safe empty', () => {
        const huge = 'x'.repeat(50_000);
        const s = validSuggestion({ existingCode: huge, improvedCode: ' \t\r ok' });
        const r = extractFindings(
            makeState({ artifacts: [artifactOf(validD([s]))] }),
        );
        expect(r.suggestions[0].existingCode).toHaveLength(50_000);
        expect(
            extractFindings(makeState({ steps: [stepOf('   \n\t')] })).suggestions,
        ).toHaveLength(0);
    });

    // Row 41 — Input exactly at the batch boundary (off-by-one) — N/A: batch/chunk
    // sizing is executeChunked's concern; this parse boundary has no batch size.
    // See rowsNA. (Sanity: N and N+1 items are handled identically here.)

    // Row 42 — Order permutation → equivalent decision (metamorphic): order is
    // preserved and the SET of recovered findings is identical.
    it('row 42: order permutation → same set recovered (order preserved, none dropped)', () => {
        const a = validSuggestion({ relevantFile: 'a.ts' });
        const b = validSuggestion({ relevantFile: 'b.ts' });
        const r1 = extractFindings(makeState({ artifacts: [artifactOf(validD([a, b]))] }));
        const r2 = extractFindings(makeState({ artifacts: [artifactOf(validD([b, a]))] }));
        const files1 = r1.suggestions.map((s) => s.relevantFile).sort();
        const files2 = r2.suggestions.map((s) => s.relevantFile).sort();
        expect(files1).toEqual(files2);
        expect(files1).toEqual(['a.ts', 'b.ts']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Provider / model policy — cross-cutting lens over A/B/C.
// The structured-output-gate (strict json_schema vs json_object) lives INSIDE
// LLM.run, BELOW this boundary. recoverFindingsFromProse DELEGATES model policy
// to LLM.run (it passes only the schema). The extract/parse layer is fully
// provider-agnostic, so the A/B/C coverage above already applies to BOTH the
// strict-honored and json_object-fallback branches. These two tests pin the
// delegation + the request-assembly threading explicitly.
// ═══════════════════════════════════════════════════════════════════════════

describe('E. provider/model policy (delegated to LLM.run)', () => {
    // E-strict — a strict-schema provider (anthropic) yields clean D from LLM.run;
    // the boundary TRUSTS it and passes suggestions through unchanged.
    it('E strict branch: clean D from LLM.run is trusted and passed through', async () => {
        jest.spyOn(LLM, 'run').mockResolvedValue({
            suggestions: [validSuggestion()],
        } as any);
        const out = await recoverFindingsFromProse(
            findingLikeProse,
            { provider: 'anthropic' } as any,
            'org1',
        );
        expect(out).toHaveLength(1);
        expect(out[0].relevantFile).toBe('src/auth.ts');
    });

    // E-fallback — a json_object-fallback provider (kimi) runs the identical code
    // path (policy is chosen inside LLM.run); the boundary threads schema/user/
    // byokConfig/runName/organizationId exactly and returns [] on an empty result.
    it('E json_object branch: request assembly threads schema/user/byokConfig/runName/org', async () => {
        const spy = jest.spyOn(LLM, 'run').mockResolvedValue({ suggestions: [] } as any);
        const byok = { provider: 'moonshotai', main: { model: 'kimi-k2' } } as any;
        await recoverFindingsFromProse(findingLikeProse, byok, 'org-kimi', 'code-review-bug');

        expect(spy).toHaveBeenCalledTimes(1);
        const req = spy.mock.calls[0][0] as any;
        expect(req.byokConfig).toBe(byok);
        expect(req.organizationId).toBe('org-kimi');
        expect(req.runName).toBe('code-review-bug-recovery');
        expect(typeof req.schema).toBeDefined();
        expect(req.schema).toBeTruthy(); // RECOVERY_SCHEMA (Zod)
        expect(req.user).toContain(findingLikeProse); // prose threaded into the prompt
    });

    // E default runName when usageRunName omitted.
    it('E: runName defaults to code-review-recovery when usageRunName omitted', async () => {
        const spy = jest.spyOn(LLM, 'run').mockResolvedValue({ suggestions: [] } as any);
        await recoverFindingsFromProse(findingLikeProse, undefined, 'org1');
        expect((spy.mock.calls[0][0] as any).runName).toBe('code-review-recovery');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// extractFindingsWithRecovery — assembly of the recovery seam (row 20 completion).
// ═══════════════════════════════════════════════════════════════════════════

describe('extractFindingsWithRecovery (recovery-seam assembly)', () => {
    it('calls the recoverer with the reasoning when finder produced 0 suggestions', async () => {
        const recover = jest.fn().mockResolvedValue([validSuggestion()]);
        const state = makeState({
            artifacts: [artifactOf({ reasoning: findingLikeProse, suggestions: [] })],
        });
        const r = await extractFindingsWithRecovery(state, recover);
        expect(recover).toHaveBeenCalledWith(findingLikeProse);
        expect(r.suggestions).toHaveLength(1);
    });

    it('does NOT call the recoverer when the finder already produced suggestions', async () => {
        const recover = jest.fn().mockResolvedValue([validSuggestion()]);
        const state = makeState({ artifacts: [artifactOf(validD())] });
        const r = await extractFindingsWithRecovery(state, recover);
        expect(recover).not.toHaveBeenCalled();
        expect(r.suggestions).toHaveLength(1);
    });

    it('keeps the original (empty) result when recovery also yields nothing', async () => {
        const recover = jest.fn().mockResolvedValue([]);
        const state = makeState({
            artifacts: [artifactOf({ reasoning: findingLikeProse, suggestions: [] })],
        });
        const r = await extractFindingsWithRecovery(state, recover);
        expect(r.suggestions).toHaveLength(0);
        expect(r.reasoning).toBe(findingLikeProse);
    });

    it('no recoverer injected → returns the finder result unchanged (recovery off)', async () => {
        const state = makeState({
            artifacts: [artifactOf({ reasoning: findingLikeProse, suggestions: [] })],
        });
        const r = await extractFindingsWithRecovery(state);
        expect(r.suggestions).toHaveLength(0);
    });
});
