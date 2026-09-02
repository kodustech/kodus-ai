// The formatter now runs through the ONE primitive (LLM.run) — mock it at that
// boundary and assert on the `user` prompt it receives (prompt composition is
// what this suite verifies; the model policy is LLM.run's own tested concern).
const mockRun = jest.fn();
jest.mock('@libs/llm/llm', () => ({
    LLM: { run: (...args: any[]) => mockRun(...args) },
}));

import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';

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
                'Additional writing guidelines from the team:',
            );
            expect(prompt).toContain(
                'Always begin findings with a verb in the imperative.',
            );
            expect(prompt).toContain(
                'The team has provided custom writing guidelines. Follow them — they take priority over the default rules above.',
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

        it('injects en-US instruction when languageResultPrompt is "en-US"', async () => {
            await formatSuggestionContent([suggestion], {
                languageResultPrompt: 'en-US',
            });

            const prompt = captureLastPrompt();
            expect(prompt).toMatch(/IMPORTANT: Write all output in/);
            expect(prompt).toMatch(/English/i);
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
        it('emits BOTH the custom guidelines block AND the language directive when both are set', async () => {
            await formatSuggestionContent([suggestion], {
                customWritingGuidelines: 'Use bullet points only.',
                languageResultPrompt: 'pt-BR',
            });

            const prompt = captureLastPrompt();
            expect(prompt).toContain('Use bullet points only.');
            expect(prompt).toMatch(/Write all output in.*Portuguese/i);
        });
    });

    describe('short-circuits', () => {
        it('returns empty map and does NOT call the LLM when there are no suggestions', async () => {
            const result = await formatSuggestionContent([], {
                customWritingGuidelines: 'irrelevant',
            });

            expect(result.size).toBe(0);
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
        it('returns the EXACT declared Map<number, FormattedSuggestion> for a well-formed bare array', async () => {
            mockRun.mockResolvedValue(
                '```json\n[{"index": 0, "suggestionContent": "clean prose"}]\n```',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result).toBeInstanceOf(Map);
            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'clean prose', improvedCode: '' }],
            ]);
        });

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
            expect(arg.timeoutMs).toBe(90_000);
            expect(typeof arg.user).toBe('string');
            // Plain text call — no schema is passed (the parse is deterministic here).
            expect(arg.schema).toBeUndefined();
        });
    });

    // -- LAYER 2: OFF-SCHEMA / N-MODEL ROBUSTNESS (the #1786 class) ----------
    describe('off-schema shapes the non-strict models actually emit', () => {
        // Shapes that the regex-based parse can still RECOVER — these must
        // produce the correct, non-empty map (robustness wins, not degrades).
        it('recovers the array out of a {result:[...]} wrapper envelope', async () => {
            mockRun.mockResolvedValue(
                JSON.stringify({
                    result: [{ index: 0, suggestionContent: 'unwrapped' }],
                }),
            );

            const result = await formatSuggestionContent([suggestion]);

            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'unwrapped', improvedCode: '' }],
            ]);
        });

        it('recovers the array from a prose-preamble + fenced block', async () => {
            mockRun.mockResolvedValue(
                'Sure, here you go:\n```json\n[{"index": 0, "suggestionContent": "polished"}]\n```\nHope that helps!',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'polished', improvedCode: '' }],
            ]);
        });

        // Shapes that CANNOT be recovered — these MUST degrade to the
        // documented fallback (an EMPTY map), never a wrong-but-non-empty one.
        // Each asserts size === 0 exactly, so a silent keep-all/keep-some would
        // fail the test.
        const unrecoverable: Array<[string, unknown]> = [
            ['null', null],
            ['undefined', undefined],
            ['empty string', ''],
            ['object {} (no .match → TypeError inside parse)', {}],
            ['bare object envelope with no array', { result: { index: 0 } }],
            ['array of objects with the WRONG keys', '[{"idx": 0, "content": "x"}]'],
            ['array of PARTIAL objects (missing suggestionContent)', '[{"index": 0}]'],
            [
                'stringified JSON with escaped quotes (json_object mode)',
                '"[{\\"index\\": 0, \\"suggestionContent\\": \\"x\\"}]"',
            ],
            ['plain prose, no JSON at all', 'Here is the cleaned suggestion text.'],
        ];

        it.each(unrecoverable)(
            'degrades to an EMPTY map (never wrong-but-non-empty) for: %s',
            async (_label, modelOutput) => {
                mockRun.mockResolvedValue(modelOutput as any);

                const result = await formatSuggestionContent([suggestion]);

                expect(result).toBeInstanceOf(Map);
                expect(result.size).toBe(0);
            },
        );

        it('never throws past its boundary even when the model returns a non-string ({})', async () => {
            mockRun.mockResolvedValue({} as any);

            await expect(
                formatSuggestionContent([suggestion]),
            ).resolves.toBeInstanceOf(Map);
        });

        // -- KNOWN DEGRADATIONS (#1786): recoverable data the parse SILENTLY
        //    drops today because of strict envelope handling. Written as
        //    it.failing asserting the CORRECT (non-degrading) behaviour — green
        //    now, flips to a real failure the day the parse is hardened. --

        it.failing(
            'KNOWN DEGRADATION: should coerce a string-typed index ("0") and keep the polish, not silently drop it',
            async () => {
                // json_object-mode models routinely stringify numeric fields.
                mockRun.mockResolvedValue(
                    '[{"index": "0", "suggestionContent": "still valid"}]',
                );

                const result = await formatSuggestionContent([suggestion]);

                // CORRECT behaviour: the suggestion IS valid, index just arrived
                // as a string — it should be coerced and kept. Today it is
                // silently dropped (size 0), shipping the comment unpolished.
                expect([...result.entries()]).toEqual([
                    [0, { suggestionContent: 'still valid', improvedCode: '' }],
                ]);
            },
        );

        it.failing(
            'KNOWN DEGRADATION: should accept a single object (not wrapped in an array) and keep the polish',
            async () => {
                // Some models return a lone object when there is exactly one item.
                mockRun.mockResolvedValue(
                    '{"index": 0, "suggestionContent": "single item"}',
                );

                const result = await formatSuggestionContent([suggestion]);

                // CORRECT behaviour: wrap-and-parse the single object. Today the
                // "array only" regex misses it → silently dropped (size 0).
                expect([...result.entries()]).toEqual([
                    [0, { suggestionContent: 'single item', improvedCode: '' }],
                ]);
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
            expect(result.size).toBe(0);
        });

        it('degrades to an empty map on a timeout-shaped rejection', async () => {
            mockRun.mockRejectedValue(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result).toBeInstanceOf(Map);
            expect(result.size).toBe(0);
        });
    });

    // -- CROSS-LAYER: the declared return type is ALWAYS honoured -----------
    describe('always returns a Map (declared type) across every layer', () => {
        const cases: Array<[string, () => void]> = [
            ['happy array', () => mockRun.mockResolvedValue('[{"index":0,"suggestionContent":"x"}]')],
            ['off-schema null', () => mockRun.mockResolvedValue(null as any)],
            ['off-schema {}', () => mockRun.mockResolvedValue({} as any)],
            ['rejection', () => mockRun.mockRejectedValue(new Error('boom'))],
        ];

        it.each(cases)('returns a Map<number, FormattedSuggestion> for: %s', async (_label, setup) => {
            setup();
            const result = await formatSuggestionContent([suggestion]);
            expect(result).toBeInstanceOf(Map);
            for (const [k, v] of result.entries()) {
                expect(typeof k).toBe('number');
                expect(typeof v.suggestionContent).toBe('string');
                expect(typeof v.improvedCode).toBe('string');
            }
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
// non-empty map would be the #1786 bug. These blocks close every applicable
// matrix row against THAT boundary.
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
        // Row 2 — bare array is the NATIVE declared payload here: happy shape.
        it('row2: recovers a plain bare array (the native declared payload)', async () => {
            mockRun.mockResolvedValue('[{"index":0,"suggestionContent":"bare"}]');

            const result = await formatSuggestionContent([suggestion]);

            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'bare', improvedCode: '' }],
            ]);
        });

        // Row 4 — wrapper keys. The greedy regex slices the inner array out of
        // ANY single wrapper with no other brackets → recovered (robustness win).
        it.each([
            ['data', (a: string) => `{"data":${a}}`],
            ['output', (a: string) => `{"output":${a}}`],
            ['response', (a: string) => `{"response":${a}}`],
            ['json', (a: string) => `{"json":${a}}`],
        ])(
            'row4: recovers the inner array from a {%s:D} wrapper envelope',
            async (_key, wrap) => {
                mockRun.mockResolvedValue(
                    wrap('[{"index":0,"suggestionContent":"unwrapped"}]'),
                );

                const result = await formatSuggestionContent([suggestion]);

                expect([...result.entries()]).toEqual([
                    [0, { suggestionContent: 'unwrapped', improvedCode: '' }],
                ]);
            },
        );

        // Row 5 — double wrapper: the array is still the only bracket pair.
        it('row5: recovers the array from a {result:{result:D}} double wrapper', async () => {
            mockRun.mockResolvedValue(
                '{"result":{"result":[{"index":0,"suggestionContent":"deep"}]}}',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'deep', improvedCode: '' }],
            ]);
        });

        // Row 6 — numeric/opaque single-key wrap.
        it.each([
            ['numeric key {"0":D}', '{"0":[{"index":0,"suggestionContent":"n"}]}'],
            ['{content:D}', '{"content":[{"index":0,"suggestionContent":"n"}]}'],
        ])('row6: recovers the array from %s', async (_label, out) => {
            mockRun.mockResolvedValue(out);

            const result = await formatSuggestionContent([suggestion]);

            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'n', improvedCode: '' }],
            ]);
        });

        // Row 11 — case / convention mismatch: keys renamed by casing/snake_case.
        // Not recoverable by the strict typeof-keyed parse → fail-safe EMPTY map
        // (never a wrong-but-non-empty result).
        it.each([
            ['PascalCase keys', '[{"Index":0,"SuggestionContent":"x"}]'],
            ['snake_case keys', '[{"index":0,"suggestion_content":"x"}]'],
        ])(
            'row11: degrades to EMPTY map on %s (fail-safe, not wrong-non-empty)',
            async (_label, out) => {
                mockRun.mockResolvedValue(out);

                const result = await formatSuggestionContent([suggestion]);

                expect(result).toBeInstanceOf(Map);
                expect(result.size).toBe(0);
            },
        );

        // Row 13 — extra unknown keys alongside the right ones: tolerate.
        it('row13: tolerates extra unknown keys and recovers the real payload', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"kept","severity":"HIGH","_debug":true,"nested":{"a":1}}]',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect([...result.entries()]).toEqual([
                [0, { suggestionContent: 'kept', improvedCode: '' }],
            ]);
        });

        // Row 15 — empty array.
        it('row15: an empty array [] yields an empty map (no items to keep)', async () => {
            mockRun.mockResolvedValue('[]');

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        // Row 16 — whitespace-only (empty string already covered upstream).
        it('row16: whitespace-only response yields an empty map', async () => {
            mockRun.mockResolvedValue('   \n\t  ');

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        // Row 18 — primitives where an object/array was expected.
        it.each([
            ['boolean true', true],
            ['number 0', 0],
            ['number 42', 42],
            ['string "ok"', 'ok'],
        ])(
            'row18: primitive return (%s) degrades to an empty map, never throws',
            async (_label, out) => {
                mockRun.mockResolvedValue(out as any);

                const result = await formatSuggestionContent([suggestion]);

                expect(result).toBeInstanceOf(Map);
                expect(result.size).toBe(0);
            },
        );

        // Row 19 — provider envelope leak.
        it('row19: OpenAI-style {choices:[{message:{content}}]} envelope degrades to empty map', async () => {
            mockRun.mockResolvedValue({
                choices: [{ message: { content: '[{"index":0,"suggestionContent":"x"}]' } }],
            } as any);

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        it('row19: tool_call arguments-as-string leak degrades to empty map', async () => {
            mockRun.mockResolvedValue(
                '{"tool_calls":[{"function":{"name":"fmt","arguments":"[{\\"index\\":0,\\"suggestionContent\\":\\"x\\"}]"}}]}',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

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

        // Row 26 — duplicate keys / duplicate index: deterministic last-wins.
        it('row26: duplicate JSON keys in an item resolve last-wins', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"first","suggestionContent":"last"}]',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.get(0)?.suggestionContent).toBe('last');
        });

        it('row26: duplicate index across items collapses last-wins (size 1)', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"A"},{"index":0,"suggestionContent":"B"}]',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(1);
            expect(result.get(0)?.suggestionContent).toBe('B');
        });

        // Row 27 — unicode / escaped newlines / emoji preserved verbatim.
        it('row27: preserves unicode, emoji and escaped newlines inside string fields', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"café \\u00e9 🚀 line1\\nline2 <b>x</b>"}]',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.get(0)?.suggestionContent).toBe(
                'café é 🚀 line1\nline2 <b>x</b>',
            );
        });
    });

    // === C. UNPARSEABLE / TRANSPORT (fail-safe layer) =====================
    describe('C. unparseable / transport fail-safe', () => {
        // Row 28 — truncated JSON (no closing bracket → no regex match).
        it('row28: truncated JSON (no closing ]) degrades to an empty map', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"cut off mid str',
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        // Row 29 — malformed JSON variants.
        it.each([
            ['trailing comma', '[{"index":0,"suggestionContent":"x"},]'],
            ['single quotes', "[{'index':0,'suggestionContent':'x'}]"],
            ['unquoted keys', '[{index:0,suggestionContent:"x"}]'],
        ])('row29: malformed JSON (%s) degrades to an empty map', async (_label, out) => {
            mockRun.mockResolvedValue(out);

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        // Row 30 — LLM.run throws — asserted upstream; re-pinned here for the row.
        it('row30: a provider throw fails safe to an empty map (never crosses the boundary)', async () => {
            mockRun.mockRejectedValue(new Error('ECONNRESET'));

            await expect(
                formatSuggestionContent([suggestion]),
            ).resolves.toEqual(new Map());
        });

        // Row 31 — error object RETURNED (not thrown).
        it('row31: an {error:...} object returned instead of text degrades to empty map', async () => {
            mockRun.mockResolvedValue({ error: { code: 'insufficient_quota' } } as any);

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        // Row 32 — empty success (content: '').
        it('row32: an empty-success ("") response degrades to an empty map', async () => {
            mockRun.mockResolvedValue('');

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        // Row 33 — refusal prose (content_filter / "I cannot help").
        it('row33: a refusal prose response degrades to an empty map', async () => {
            mockRun.mockResolvedValue(
                "I'm sorry, but I can't help with rewriting that content.",
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });

        // Row 34 — abort mid-call. The method does not thread an abortSignal of
        // its own; an aborted call surfaces as a rejection → fail-safe empty map.
        it('row34: an AbortError rejection fails safe to an empty map', async () => {
            mockRun.mockRejectedValue(
                Object.assign(new Error('The operation was aborted'), {
                    name: 'AbortError',
                }),
            );

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(0);
        });
    });

    // === D. INPUT VARIANTS ================================================
    describe('D. input variants', () => {
        // Row 35 — empty input: short-circuits without calling the model.
        it('row35: empty input returns an empty map and never calls LLM.run', async () => {
            const result = await formatSuggestionContent([]);

            expect(result.size).toBe(0);
            expect(mockRun).not.toHaveBeenCalled();
        });

        // Row 36 — single item.
        it('row36: a single suggestion maps to a single entry', async () => {
            mockRun.mockResolvedValue('[{"index":0,"suggestionContent":"one"}]');

            const result = await formatSuggestionContent([suggestion]);

            expect(result.size).toBe(1);
            expect(mockRun).toHaveBeenCalledTimes(1);
        });

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

        // Row 38 — duplicate items in the input.
        it('row38: duplicate input items each get their own indexed entry', async () => {
            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"a"},{"index":1,"suggestionContent":"b"}]',
            );

            const result = await formatSuggestionContent([suggestion, suggestion]);

            expect(result.size).toBe(2);
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

        // Row 40 — special chars / whitespace-only / huge diff in the input.
        it('row40: special chars and whitespace-only diffs build a prompt without crashing', async () => {
            mockRun.mockResolvedValue('[{"index":0,"suggestionContent":"ok"}]');
            const weird = {
                suggestionContent: 'emoji 🚀 and ```backticks``` and  null-ish',
                existingCode: '   \n\t   ',
                improvedCode: '𝕏 unicode '.repeat(500),
                relevantFile: 'src/файл.ts',
                language: 'TypeScript',
            };

            await formatSuggestionContent([weird]);

            const prompt = mockRun.mock.calls[0][0].user as string;
            expect(prompt).toContain('src/файл.ts');
            expect(prompt).toContain('🚀');
        });

        // Row 42 — order permutation (metamorphic): the map is keyed by the
        // returned index, so array order in the model response is irrelevant.
        it('row42: response array order does not change the resulting map', async () => {
            mockRun.mockResolvedValue(
                '[{"index":1,"suggestionContent":"B"},{"index":0,"suggestionContent":"A"}]',
            );
            const forward = await formatSuggestionContent([suggestion, suggestion]);

            mockRun.mockResolvedValue(
                '[{"index":0,"suggestionContent":"A"},{"index":1,"suggestionContent":"B"}]',
            );
            const reversed = await formatSuggestionContent([suggestion, suggestion]);

            expect([...forward.entries()].sort((a, b) => a[0] - b[0])).toEqual(
                [...reversed.entries()].sort((a, b) => a[0] - b[0]),
            );
            expect(forward.get(0)?.suggestionContent).toBe('A');
            expect(forward.get(1)?.suggestionContent).toBe('B');
        });
    });

    // === E. PROVIDER / MODEL MATRIX ======================================
    // The boundary does NOT branch on model — it forwards `byokConfig` to
    // LLM.run (whose structured-output-gate is its own tested concern) and then
    // re-parses the returned TEXT deterministically. So the full A/B/C zoo is in
    // scope for EVERY slot: it never blindly trusts a strict-json_schema model's
    // output, and it applies the same recovery/fail-safe to a json_object
    // fallback model. These tests pin that model-invariance at the parse layer.
    describe('E. model-policy invariance (strict-schema vs json_object fallback)', () => {
        const strictSlot = { model: 'openai/gpt-4o' } as any; // json_schema honored
        const fallbackSlot = { model: 'moonshotai/kimi-k2' } as any; // json_object fallback

        it('recovers a wrapper-envelope shape identically under both slots', async () => {
            const out = '{"result":[{"index":0,"suggestionContent":"same"}]}';

            mockRun.mockResolvedValue(out);
            const strict = await formatSuggestionContent([suggestion], {
                byokConfig: strictSlot,
            });

            mockRun.mockResolvedValue(out);
            const fallback = await formatSuggestionContent([suggestion], {
                byokConfig: fallbackSlot,
            });

            expect([...strict.entries()]).toEqual([...fallback.entries()]);
            expect(strict.get(0)?.suggestionContent).toBe('same');
        });

        it('applies the same fail-safe empty map to an unrecoverable shape under both slots', async () => {
            const out = '[{"idx":0,"content":"wrong keys"}]';

            mockRun.mockResolvedValue(out);
            const strict = await formatSuggestionContent([suggestion], {
                byokConfig: strictSlot,
            });

            mockRun.mockResolvedValue(out);
            const fallback = await formatSuggestionContent([suggestion], {
                byokConfig: fallbackSlot,
            });

            expect(strict.size).toBe(0);
            expect(fallback.size).toBe(0);
        });

        it('forwards the exact byokConfig slot to LLM.run for both strict and fallback models', async () => {
            mockRun.mockResolvedValue('[{"index":0,"suggestionContent":"x"}]');

            await formatSuggestionContent([suggestion], { byokConfig: strictSlot });
            expect(mockRun.mock.calls.at(-1)?.[0].byokConfig).toBe(strictSlot);

            await formatSuggestionContent([suggestion], { byokConfig: fallbackSlot });
            expect(mockRun.mock.calls.at(-1)?.[0].byokConfig).toBe(fallbackSlot);
        });
    });
});
