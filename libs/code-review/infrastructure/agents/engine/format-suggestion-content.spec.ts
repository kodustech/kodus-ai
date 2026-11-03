// The formatter now runs through the ONE primitive (LLM.run) — mock it at that
// boundary and assert on the `user` prompt it receives (prompt composition is
// what this suite verifies; the model policy is LLM.run's own tested concern).
const mockRun = jest.fn();
jest.mock('@libs/llm/llm', () => ({
    LLM: { run: (...args: any[]) => mockRun(...args) },
}));

import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';

/**
 * The fail-safe contract, restated.
 *
 * These cases used to assert an EMPTY map, under the principle "never
 * wrong-but-non-empty". The principle holds; the conclusion did not. An empty
 * map means the caller keeps the RAW suggestion — and the raw suggestion is the
 * WHAT/WHY/HOW scaffolding the review prompt instructs the finder to write. So
 * "degrade to empty" was, in practice, "ship the internal template to the
 * customer". Production did exactly that in 86 of 732 formatter runs across
 * twelve hours, from five unrelated causes.
 *
 * The formatter now removes the labels locally when the model pass gives it
 * nothing. That is still fail-safe in the sense these tests care about: no
 * model output reaches the caller, and nothing is invented — every word is the
 * finder's own, minus three labels.
 *
 * The fixture is `WHAT: x. WHY: y. HOW: z.`, so the de-scaffolded form is
 * exactly `x. y. z.`. Asserting the literal keeps this honest: if the fallback
 * ever starts rewording, this fails.
 */
const expectFailSafe = (result: Map<number, any>) => {
    expect(result).toBeInstanceOf(Map);
    for (const [, value] of result) {
        expect(value.suggestionContent).not.toMatch(/WHAT\s*:|WHY\s*:|HOW\s*:/i);
        expect(value.suggestionContent).toBe('x. y. z.');
    }
};

describe('formatSuggestionContent — prompt composition', () => {
    const suggestion = {
        suggestionContent: 'WHAT: x. WHY: y. HOW: z.',
        existingCode: 'a',
        improvedCode: 'b',
        relevantFile: 'src/foo.ts',
        language: 'TypeScript',
    };

    beforeEach(() => {
        mockRun.mockReset();
        // LLM.run returns the raw text (no schema) — the formatter parses it.
        mockRun.mockResolvedValue(
            '```json\n[{"index": 0, "suggestionContent": "ok"}]\n```',
        );
    });

    const captureLastPrompt = (): string => {
        const call = mockRun.mock.calls.at(-1);
        return call?.[0]?.user ?? '';
    };

    describe('customWritingGuidelines', () => {
        it('injects the team guidelines verbatim into the prompt', async () => {
            await formatSuggestionContent([suggestion], {
                customWritingGuidelines:
                    'Always begin findings with a verb in the imperative.',
            });

            const prompt = captureLastPrompt();
            expect(prompt).toContain(
                'Always begin findings with a verb in the imperative.',
            );
            expect(prompt).toContain(
                'The team has provided custom writing guidelines. Follow them for tone and length — they take priority over the default rules above.',
            );
        });

        it('omits the guidelines block when no custom guidelines are provided', async () => {
            await formatSuggestionContent([suggestion], {});

            const prompt = captureLastPrompt();
            expect(prompt).not.toContain(
                'Additional writing guidelines from the team:',
            );
            expect(prompt).not.toContain(
                'The team has provided custom writing guidelines',
            );
        });
    });

    describe('languageResultPrompt (idioma do team)', () => {
        it('injects pt-BR positive instruction when languageResultPrompt is "pt-BR"', async () => {
            await formatSuggestionContent([suggestion], {
                languageResultPrompt: 'pt-BR',
            });

            const prompt = captureLastPrompt();
            // Display name "Brazilian Portuguese" or similar
            expect(prompt).toMatch(/IMPORTANT: Write all output in/);
            expect(prompt).toMatch(/Portuguese/i);
            expect(prompt).toContain('Do not fall back to English.');
        });

        it('still emits a language directive for unusual locales (does not silently drop)', async () => {
            await formatSuggestionContent([suggestion], {
                languageResultPrompt: 'xx-YY',
            });

            const prompt = captureLastPrompt();
            // Intl.DisplayNames produces "xx (YY)" or similar; just verify the directive is present.
            expect(prompt).toMatch(/IMPORTANT: Write all output in/);
            expect(prompt).toContain('Do not fall back to English.');
        });

        it('omits the language directive when no languageResultPrompt is provided', async () => {
            await formatSuggestionContent([suggestion], {});

            const prompt = captureLastPrompt();
            expect(prompt).not.toContain('IMPORTANT: Write all output in');
            expect(prompt).not.toContain('Do not fall back to English');
        });
    });

    describe('combined', () => {
    });

    describe('short-circuits', () => {
        it('returns empty map and does NOT call the LLM when there are no suggestions', async () => {
            const result = await formatSuggestionContent([], {
                customWritingGuidelines: 'irrelevant',
            });

            expectFailSafe(result);
            expect(mockRun).not.toHaveBeenCalled();
        });
    });
});

// ---------------------------------------------------------------------------
// CONTRACT TESTS for the LLM.run boundary (issue #1786).
//
// formatSuggestionContent wraps ONE LLM.run text call, then runs a
// deterministic parse (parseFormatResponse) whose only side effect is the
// returned Map<number, FormattedSuggestion>. These tests pin the three
// contract layers around that boundary — happy shape, off-schema/N-model
// robustness, and provider-error fail-safe — and prove the method ALWAYS
// honours its declared return type (a Map) regardless of what the model emits.
//
// The #1786 danger is a model returning JSON in the wrong envelope (kimi / glm /
// deepseek / z-ai fall back to json_object mode and emit stringified JSON, bare
// wrappers, string-typed fields, single objects instead of arrays). The failure
// we guard against is the method turning that into a WRONG-BUT-NON-EMPTY result,
// or throwing past its boundary. The documented fallback is an EMPTY map
// ("comments still ship, minus the prose polish") — never a wrong map.
// ---------------------------------------------------------------------------
describe('formatSuggestionContent — LLM.run contract (#1786)', () => {
    const suggestion = {
        suggestionContent: 'WHAT: x. WHY: y. HOW: z.',
        existingCode: 'a',
        improvedCode: 'b',
        relevantFile: 'src/foo.ts',
        language: 'TypeScript',
    };

    beforeEach(() => {
        mockRun.mockReset();
    });

    // -- LAYER 1: HAPPY PATH -------------------------------------------------
    describe('happy path (correct schema shape)', () => {
        it('maps each index to its own entry and keeps improvedCode when the model returns it', async () => {
            mockRun.mockResolvedValue(
                JSON.stringify([
                    { index: 0, suggestionContent: 'first', improvedCode: 'CODE0' },
                    { index: 1, suggestionContent: 'second' },
                ]),
            );

            const result = await formatSuggestionContent([
                suggestion,
                suggestion,
            ]);

            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'first', improvedCode: 'CODE0' }],
                [1, { suggestionContent: 'second', improvedCode: '' }],
            ]);
        });

        it('assembles the LLM.run request with the declared fields (slot, runName, timeout, org)', async () => {
            mockRun.mockResolvedValue(
                '[{"index": 0, "suggestionContent": "ok"}]',
            );
            const byokConfig = { some: 'slot' } as any;

            await formatSuggestionContent([suggestion], {
                byokConfig,
                organizationId: 'org-123',
            });

            expect(mockRun).toHaveBeenCalledTimes(1);
            const arg = mockRun.mock.calls[0][0];
            expect(arg.byokConfig).toBe(byokConfig);
            expect(arg.organizationId).toBe('org-123');
            expect(arg.runName).toBe('suggestion-formatter');
            expect(arg.timeoutMs).toBe(120_000);
            // This pass rewrites prose; it decides nothing, so it reasons about
            // nothing. Left on, the models doing it spent 69-100% of their
            // output tokens reasoning and routinely reached the old ceiling.
            expect(arg.suppressReasoning).toBe(true);
            expect(typeof arg.user).toBe('string');
            // Plain text call — no schema is passed (the parse is deterministic here).
            expect(arg.schema).toBeUndefined();
        });
    });

    // -- LAYER 2: OFF-SCHEMA / N-MODEL ROBUSTNESS (the #1786 class) ----------
    describe('off-schema shapes the non-strict models actually emit', () => {
        // Shapes that CANNOT be recovered — these MUST degrade to the
        // documented fallback (an EMPTY map), never a wrong-but-non-empty one.
        // Each asserts size === 0 exactly, so a silent keep-all/keep-some would
        // fail the test.
        const unrecoverable: Array<[string, unknown]> = [
            ['null', null],
            ['undefined', undefined],
            ['object {} (no .match → TypeError inside parse)', {}],
            ['plain prose, no JSON at all', 'Here is the cleaned suggestion text.'],
        ];

        it.each(unrecoverable)(
            'degrades to an EMPTY map (never wrong-but-non-empty) for: %s',
            async (_label, modelOutput) => {
                mockRun.mockResolvedValue(modelOutput as any);

                const result = await formatSuggestionContent([suggestion]);

                expectFailSafe(result);
            },
        );
    });

    // -- LAYER 3: FAIL-SAFE (provider error / suspended key) ----------------
    describe('fail-safe on LLM.run rejection', () => {
        it('degrades to an empty map when the provider call rejects, and does NOT throw', async () => {
            mockRun.mockRejectedValue(new Error('provider 500 / suspended key'));

            const result = await formatSuggestionContent([suggestion], {
                organizationId: 'org-err',
            });

            expect(result).toBeInstanceOf(Map);
            expectFailSafe(result);
        });
    });
});

// ---------------------------------------------------------------------------
// FULL I/O CONTRACT MATRIX BACKFILL (#1786).
//
// The LLM.run site here is a PLAIN TEXT call (no `schema` passed) whose declared
// textual payload D is a JSON array of {index:number, suggestionContent:string,
// improvedCode?:string}. The parse (parseFormatResponse) is deterministic:
//   1. greedy regex /\[[\s\S]*\]/  (first '[' .. last ']')
//   2. JSON.parse of that slice
//   3. keep items where typeof index === 'number' && typeof suggestionContent === 'string'
// On any failure the method returns an EMPTY Map AND logs logger.warn — this is
// the documented, OBSERVABLE fail-safe ("comments still ship, minus the polish"),
// i.e. the "fail explicitly" branch of the non-degradation rule. A wrong-but-
// non-empty map would be the #1786 bug. The parse-only rows live in
// format-prompt.input-matrix.spec.ts; what stays here is what the boundary adds.
//
// N/A rows for this boundary:
//   21,22,23,24 — no boolean/enum field exists in D (fields are index:number,
//                 suggestionContent:string, improvedCode:string).
//   41         — the method sends ALL suggestions in ONE prompt; there is no
//                 batch/chunk boundary, so "off-by-one at the batch edge" is moot
//                 (row 37 still asserts the single-call / large-input invariant).
// ---------------------------------------------------------------------------
describe('formatSuggestionContent — full I/O contract matrix (#1786 backfill)', () => {
    const suggestion = {
        suggestionContent: 'WHAT: x. WHY: y. HOW: z.',
        existingCode: 'a',
        improvedCode: 'b',
        relevantFile: 'src/foo.ts',
        language: 'TypeScript',
    };

    beforeEach(() => {
        mockRun.mockReset();
    });

    // === A. OUTPUT-SHAPE ZOO ===============================================
    describe('A. output-shape zoo', () => {
        // Row 20 — reasoning/thinking leak whose stray brackets corrupt the greedy
        // slice. The trailing array IS valid and recoverable, but the first '['
        // lands inside the thinking prose → JSON.parse fails → data dropped.
        // KNOWN DEGRADATION: correct behaviour is to recover the real array.
        // Source: libs/code-review/infrastructure/agents/engine/format-prompt.ts:80
        it.failing(
            'row20: KNOWN DEGRADATION — should recover the trailing array despite a thinking-leak with stray brackets',
            async () => {
                mockRun.mockResolvedValue(
                    '<thinking>compare items [0] and [1] carefully</thinking>\n[{"index":0,"suggestionContent":"real"}]',
                );

                const result = await formatSuggestionContent([suggestion]);

                // CORRECT: the valid trailing array should be recovered. Today the
                // greedy first-'[' regex swallows the thinking brackets and JSON
                // parse fails → silently dropped to an empty map.
                expect([...result.entries()]).toEqual([
                    [0, { suggestionContent: 'real', improvedCode: '' }],
                ]);
            },
        );
    });

    // === B. SEMANTIC-BUT-WRONG (valid JSON, wrong value encoding) ==========
    // Rows 21-24 (boolean/enum encodings) are N/A: D has no boolean/enum field.
    describe('B. semantic-but-wrong value encodings', () => {
        // Row 25 — dangling / out-of-range index reference.
        it('row25: an out-of-range index does not corrupt the valid entry', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"valid"},{"index":99,"suggestionContent":"orphan"}]',
            );

            const result = await formatSuggestionContent([suggestion]);

            // The in-range entry is preserved exactly; a dangling index cannot
            // overwrite or drop it (the caller looks up by its own real index).
            expect(result.get(0)).toEqual({
                suggestionContent: 'valid',
                improvedCode: '',
            });
        });

        it('row26: duplicate index across items collapses last-wins (size 1)', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"A"},{"index":0,"suggestionContent":"B"}]',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(1);
            expect(result.get(0)?.suggestionContent).toBe('B');
        });
    });

    // === D. INPUT VARIANTS ================================================
    describe('D. input variants', () => {
        // Row 37 — large input: no batching, ONE call, every index mapped.
        it('row37: a large input is sent in ONE call and every index is mapped', async () => {
            const n = 60;
            const big = Array.from({ length: n }, () => suggestion);
            mockRun.mockResolvedValue(
                JSON.stringify(
                    Array.from({ length: n }, (_v, i) => ({
                        index: i,
                        suggestionContent: `s${i}`,
                    })),
                ),
            );

            const result = await formatSuggestionContent(big);

            expect(mockRun).toHaveBeenCalledTimes(1);
            expect(result.size).toBe(n);
            expect(result.get(59)?.suggestionContent).toBe('s59');
        });

        // Row 39 — input item with null/undefined required fields.
        it('row39: null/undefined fields in the input do not crash the boundary', async () => {
            mockRun.mockResolvedValue('[{"index":0,"suggestionContent":"ok"}]');
            const dirty = {
                suggestionContent: null as any,
                existingCode: undefined,
                improvedCode: undefined,
                relevantFile: undefined,
                language: undefined,
            };

            await expect(
                formatSuggestionContent([dirty]),
            ).resolves.toBeInstanceOf(Map);
            expect(mockRun).toHaveBeenCalledTimes(1);
        });
    });
});
