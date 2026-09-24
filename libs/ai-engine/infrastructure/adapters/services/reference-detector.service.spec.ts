import { ReferenceDetectorService } from './reference-detector.service';
import { LLM } from '@libs/llm/llm';
import { KODUS_TRIAL_MODEL } from '@libs/llm/byok-defaults';
import { prompt_detect_external_references_system } from '@libs/common/utils/prompts/externalReferences';
import { prompt_kodyrules_detect_references_system } from '@libs/common/utils/prompts/kodyRulesExternalReferences';

/**
 * The deterministic front of external-reference handling: a cheap heuristic gate
 * that decides whether the expensive LLM detection even runs, and the marker
 * extraction that feeds context loading. A false negative here means the review
 * silently loses referenced context; a control marker leaking through as a file
 * would try to load a non-file. Both are pinned.
 */
describe('ReferenceDetectorService — reference detection & marker extraction', () => {
    const svc = new ReferenceDetectorService();

    describe('hasLikelyExternalReferences', () => {
        it.each([
            ['@file: src/a.ts', '@file: prefix'],
            ['[[file:src/a.ts]]', '[[file:]] marker'],
            ['edit @utils.ts please', '@name.ext'],
            ['please refer to config.ts', '"refer to ...ext"'],
            ['check the setup in MY_CONSTANTS.ts', 'SCREAMING_CASE.ext'],
            ['update the README.md', 'well-known doc file'],
        ])('detects a likely reference in %j (%s)', (text) => {
            expect(svc.hasLikelyExternalReferences(text)).toBe(true);
        });

        it('returns false for prose with no reference-like token', () => {
            expect(svc.hasLikelyExternalReferences('just refactor the thing')).toBe(
                false,
            );
            expect(svc.hasLikelyExternalReferences('')).toBe(false);
        });
    });

    /**
     * ── LLM.run I/O contract for detectReferences (the deterministic layer) ──
     *
     * The ONE LLM.run site (reference-detector.service.ts:159) is a TEXT call —
     * it passes NO `schema`, so the model returns a raw string and the boundary
     * parses it with `extractJsonFromResponse` (prompt-parser.utils.ts), which
     * only accepts a top-level JSON ARRAY. The declared return is always
     * `IDetectedReference[]`. These tests pin request assembly (exact args /
     * system / user / byokConfig threading), envelope parsing across the
     * output-shape zoo, the fail-safe layer, input variants, and the
     * always-an-array return invariant. Model DECISION quality is out of scope.
     *
     * Provider policy (matrix E): because this boundary passes no `schema`, it
     * NEVER touches the structured-output gate — every provider (strict
     * json_schema: anthropic/openai/google/moonshotai, OR json_object fallback:
     * kimi/glm/deepseek/z-ai) flows through the SAME free-text → parse path, so
     * the full A/B/C zoo is universally in scope regardless of the slot. This is
     * asserted explicitly under matrix row 3.
     */
    describe('detectReferences — LLM.run I/O contract', () => {
        const svc = new ReferenceDetectorService();

        const SLOT = { provider: 'anthropic', model: 'claude-x' } as any;

        const baseParams = (over: Record<string, unknown> = {}) => ({
            requirementId: 'req-1',
            promptText: 'please check @src/utils.ts for details',
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            byokConfig: SLOT,
            ...over,
        });

        const REF = { fileName: 'src/utils.ts', originalText: '@src/utils.ts' };

        const mockRun = (value: unknown) =>
            jest.spyOn(LLM, 'run').mockResolvedValue(value as any);

        afterEach(() => {
            jest.restoreAllMocks();
        });

        // ── Request assembly (deterministic: exact args / schema / system / user / byok) ──
        describe('request assembly', () => {
            it('calls LLM.run exactly once as a TEXT call (no schema) with the resolved slot, runName and telemetry', async () => {
                const spy = mockRun('[]');
                await svc.detectReferences(baseParams() as any);

                expect(spy).toHaveBeenCalledTimes(1);
                const arg = spy.mock.calls[0][0] as any;
                expect(arg.schema).toBeUndefined();
                expect('schema' in arg).toBe(false);
                expect(arg.byokConfig).toBe(SLOT);
                expect(arg.runName).toBe('detectExternalReferences');
                expect(arg.organizationId).toBe('org-1');
                expect(arg.telemetryMetadata).toEqual({
                    organizationId: 'org-1',
                    teamId: 'team-1',
                });
            });

            it('uses the external-reference prompts in the default (prompt) detection mode', async () => {
                const spy = mockRun('[]');
                await svc.detectReferences(baseParams() as any);
                const arg = spy.mock.calls[0][0] as any;
                expect(arg.system).toBe(
                    prompt_detect_external_references_system(),
                );
                expect(arg.user).toContain('please check @src/utils.ts');
            });

            it('uses the Kody-rules prompts when detectionMode is "rule"', async () => {
                const spy = mockRun('[]');
                await svc.detectReferences(
                    baseParams({ detectionMode: 'rule' }) as any,
                );
                const arg = spy.mock.calls[0][0] as any;
                expect(arg.system).toBe(
                    prompt_kodyrules_detect_references_system(),
                );
                expect(arg.user).toContain('Rule text to analyze');
            });

            it('threads the trial default override when subscriptionStatus is "trial"', async () => {
                const spy = mockRun('[]');
                await svc.detectReferences(
                    baseParams({
                        byokConfig: undefined,
                        subscriptionStatus: 'trial',
                    }) as any,
                );
                const arg = spy.mock.calls[0][0] as any;
                expect(arg.defaultModelOverride).toBe(KODUS_TRIAL_MODEL);
            });

            it('sends no default override off-trial (resolver uses env/prod default)', async () => {
                const spy = mockRun('[]');
                await svc.detectReferences(
                    baseParams({ subscriptionStatus: 'active' }) as any,
                );
                const arg = spy.mock.calls[0][0] as any;
                expect(arg.defaultModelOverride).toBeUndefined();
            });
        });

        // ── A. Output-shape zoo (rows 1-20) ──
        describe('A. output-shape zoo', () => {
            it('row 1/2 — exact D (JSON array string): returns the parsed refs verbatim, in order', async () => {
                mockRun(
                    JSON.stringify([
                        { fileName: 'a.ts' },
                        { fileName: 'b.ts' },
                    ]),
                );
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'a.ts' }, { fileName: 'b.ts' }]);
            });

            // row 3 — single OBJECT where D expects an ARRAY. extractJsonFromResponse
            // returns null for a non-array, so the boundary DROPS a recoverable
            // reference and ships [] with no signal (#1786 silent-drop class).
            // Source: reference-detector.service.ts:176.
            it.failing(
                'row 3 — single object should be recovered as a 1-element array (SILENT DROP today)',
                async () => {
                    mockRun(JSON.stringify({ fileName: 'src/a.ts' }));
                    const out = await svc.detectReferences(baseParams() as any);
                    expect(out).toEqual([{ fileName: 'src/a.ts' }]);
                },
            );

            it('row 4 — wrapper key {result:[...]}: recovers the inner array via bracket-slice', async () => {
                mockRun(JSON.stringify({ result: [{ fileName: 'a.ts' }] }));
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'a.ts' }]);
            });

            it('row 5 — double wrapper {result:{result:[...]}}: still recovers the inner array', async () => {
                mockRun(
                    JSON.stringify({ result: { result: [{ fileName: 'a.ts' }] } }),
                );
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'a.ts' }]);
            });

            it('row 6 — opaque single-key wrap {"0":[...]} / {content:[...]}: recovers', async () => {
                mockRun(JSON.stringify({ '0': [{ fileName: 'a.ts' }] }));
                expect(await svc.detectReferences(baseParams() as any)).toEqual([
                    { fileName: 'a.ts' },
                ]);
                jest.restoreAllMocks();
                mockRun(JSON.stringify({ content: [{ fileName: 'b.ts' }] }));
                expect(await svc.detectReferences(baseParams() as any)).toEqual([
                    { fileName: 'b.ts' },
                ]);
            });

            it('row 7 — stringified JSON (array wrapped in a JSON string): unwrap + recover', async () => {
                mockRun(JSON.stringify(JSON.stringify([{ fileName: 'a.ts' }])));
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'a.ts' }]);
            });

            it('row 8 — markdown-fenced ```json [...] ```: strips fence + recovers', async () => {
                mockRun('```json\n[{"fileName":"a.ts"}]\n```');
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'a.ts' }]);
            });

            it('row 9 — prose-wrapped "Here is the result: [...]": bracket-slice recovers', async () => {
                mockRun('Here is the result: [{"fileName":"a.ts"}]. Done!');
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'a.ts' }]);
            });

            it('row 10 — right data, wrong keys: passes through unchanged (this layer does NOT remap/validate keys)', async () => {
                mockRun(JSON.stringify([{ path: 'src/a.ts' }]));
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ path: 'src/a.ts' }]);
            });

            // row 11 — case/convention mismatch on the control-marker key. The
            // filter only checks lowercase filePath/fileName/originalText
            // (service:179-184), so a marker under `FileName` LEAKS through as a
            // file — the exact "@kody-sync as a file" class the service header
            // warns about. Source: reference-detector.service.ts:179-184.
            it.failing(
                'row 11 — control marker under a case-variant key must still be filtered (LEAKS today)',
                async () => {
                    mockRun(JSON.stringify([{ FileName: '@kody-sync' }]));
                    const out = await svc.detectReferences(baseParams() as any);
                    expect(out).toEqual([]);
                },
            );

            it('row 12 — partial object (only some keys): tolerated, returned as-is', async () => {
                mockRun(JSON.stringify([{ fileName: 'src/a.ts' }]));
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'src/a.ts' }]);
            });

            it('row 13 — extra unknown keys: tolerated, not crashed', async () => {
                mockRun(
                    JSON.stringify([
                        { fileName: 'a.ts', originalText: '@a', weird: 123 },
                    ]),
                );
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([
                    { fileName: 'a.ts', originalText: '@a', weird: 123 },
                ]);
            });

            it('row 14 — empty object {}: no array → fail-safe []', async () => {
                mockRun('{}');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 15 — empty array []: returns []', async () => {
                mockRun('[]');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 16 — empty / whitespace-only string: returns []', async () => {
                mockRun('');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
                jest.restoreAllMocks();
                mockRun('   \n  ');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 17 — null / undefined return: returns []', async () => {
                mockRun(null);
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
                jest.restoreAllMocks();
                mockRun(undefined);
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 18 — primitive where object expected (true / 0 / "ok"): returns []', async () => {
                for (const v of ['true', '0', '"ok"']) {
                    jest.restoreAllMocks();
                    mockRun(v);
                    expect(
                        await svc.detectReferences(baseParams() as any),
                    ).toEqual([]);
                }
            });

            // row 19 — provider envelope leak {choices:[{message:{content}}]}.
            // The bracket-slice grabs the `choices` array, so the boundary ships
            // the RAW message object as if it were a reference (never extracts
            // the inner content). Source: reference-detector.service.ts:175-196
            // + prompt-parser.utils.ts bracket-slice.
            it.failing(
                'row 19 — provider envelope must NOT leak as a reference (recover inner payload) (LEAKS today)',
                async () => {
                    mockRun(
                        JSON.stringify({
                            choices: [
                                {
                                    message: {
                                        content:
                                            '[{"fileName":"real.ts"}]',
                                    },
                                },
                            ],
                        }),
                    );
                    const out = await svc.detectReferences(baseParams() as any);
                    expect(out).toEqual([{ fileName: 'real.ts' }]);
                },
            );

            it('row 20 — reasoning/thinking leak before the array: bracket-slice recovers the array', async () => {
                mockRun(
                    '<thinking>let me look for refs</thinking>\n[{"fileName":"a.ts"}]',
                );
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'a.ts' }]);
            });
        });

        // ── B. Semantic-but-wrong (rows 21-27) ──
        describe('B. semantic-but-wrong', () => {
            it('row 26 — duplicate keys in a ref object: JSON last-wins, no crash', async () => {
                mockRun('[{"fileName":"a.ts","fileName":"b.ts"}]');
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([{ fileName: 'b.ts' }]);
            });

            it('row 27 — unicode / emoji / escaped newlines in string fields: preserved intact', async () => {
                mockRun(
                    JSON.stringify([
                        {
                            fileName: 'src/café_🚀.ts',
                            originalText: '@café\nnext',
                        },
                    ]),
                );
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([
                    { fileName: 'src/café_🚀.ts', originalText: '@café\nnext' },
                ]);
            });
        });

        // ── C. Unparseable / transport — the fail-safe layer (rows 28-34) ──
        describe('C. unparseable / transport', () => {
            it('row 28 — truncated JSON (mid-object, no closing ]): fail-safe []', async () => {
                mockRun('[{"fileName":"a.ts"');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 29 — malformed JSON (trailing comma / single quotes): fail-safe []', async () => {
                mockRun('[{"fileName":"a.ts"},]');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
                jest.restoreAllMocks();
                mockRun("[{'fileName':'a.ts'}]");
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 30 — LLM.run throws: signals explicitly (rejects; no silent []) ', async () => {
                jest.spyOn(LLM, 'run').mockRejectedValue(
                    new Error('network timeout'),
                );
                await expect(
                    svc.detectReferences(baseParams() as any),
                ).rejects.toThrow('network timeout');
            });

            it('row 31 — {error:...} returned as content instead of throwing: fail-safe []', async () => {
                mockRun(JSON.stringify({ error: 'model unavailable' }));
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
                // non-string object leak guarded by extractJsonFromResponse too
                jest.restoreAllMocks();
                mockRun({ error: 'model unavailable' });
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 32 — empty success (content = ""): fail-safe []', async () => {
                mockRun('');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 33 — refusal prose ("I cannot help..."): no array → fail-safe []', async () => {
                mockRun('I cannot help with that request.');
                expect(await svc.detectReferences(baseParams() as any)).toEqual(
                    [],
                );
            });

            it('row 34 — abort-signal rejection propagates (boundary threads no signal; behaves like row 30)', async () => {
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                jest.spyOn(LLM, 'run').mockRejectedValue(abortErr);
                await expect(
                    svc.detectReferences(baseParams() as any),
                ).rejects.toThrow('The operation was aborted');
            });
        });

        // ── D. Input variants (rows 35-42) ──
        describe('D. input variants', () => {
            it('row 35 — empty input (empty promptText): still calls LLM.run once, returns []', async () => {
                const spy = mockRun('[]');
                const out = await svc.detectReferences(
                    baseParams({ promptText: '' }) as any,
                );
                expect(spy).toHaveBeenCalledTimes(1);
                expect(out).toEqual([]);
            });

            it('row 36 — single item: returns the one detected reference', async () => {
                mockRun(JSON.stringify([REF]));
                const out = await svc.detectReferences(baseParams() as any);
                expect(out).toEqual([REF]);
            });

            it('row 37 — large input: sent in ONE call (no chunking/batching in this boundary)', async () => {
                const spy = mockRun('[]');
                const huge =
                    'refer to @big.ts ' + 'x'.repeat(200_000) + ' @end.ts';
                await svc.detectReferences(
                    baseParams({ promptText: huge }) as any,
                );
                expect(spy).toHaveBeenCalledTimes(1);
            });

            it('row 38 — duplicate mentions in input: no input-dedup, single call, model output returned as-is', async () => {
                const spy = mockRun(JSON.stringify([{ fileName: 'a.ts' }]));
                await svc.detectReferences(
                    baseParams({
                        promptText: 'see @a.ts and again @a.ts',
                    }) as any,
                );
                expect(spy).toHaveBeenCalledTimes(1);
            });

            it('row 39 — null/undefined required fields (no org/team, no byok): does not crash, returns array', async () => {
                mockRun('[]');
                const spy = jest.spyOn(LLM, 'run');
                const out = await svc.detectReferences({
                    requirementId: 'r',
                    promptText: 'see @a.ts',
                    organizationAndTeamData: {} as any,
                    byokConfig: undefined,
                } as any);
                expect(Array.isArray(out)).toBe(true);
                const arg = spy.mock.calls[0][0] as any;
                expect(arg.organizationId).toBeUndefined();
            });

            it('row 40 — special chars + control markers: markers stripped from the user prompt before the model sees them', async () => {
                const spy = mockRun('[]');
                await svc.detectReferences(
                    baseParams({
                        promptText:
                            'see @kody-sync and @real.ts also @kody-ignore 🚀',
                    }) as any,
                );
                const arg = spy.mock.calls[0][0] as any;
                expect(arg.user).not.toContain('@kody-sync');
                expect(arg.user).not.toContain('@kody-ignore');
                expect(arg.user).toContain('@real.ts');
                expect(arg.user).toContain('🚀');
            });

            it('row 42 — order permutation: boundary is order-preserving passthrough (no reordering)', async () => {
                jest.spyOn(LLM, 'run').mockResolvedValueOnce(
                    JSON.stringify([{ fileName: 'a' }, { fileName: 'b' }]) as any,
                );
                const first = await svc.detectReferences(baseParams() as any);
                jest.spyOn(LLM, 'run').mockResolvedValueOnce(
                    JSON.stringify([{ fileName: 'b' }, { fileName: 'a' }]) as any,
                );
                const second = await svc.detectReferences(baseParams() as any);
                expect(first).toEqual([{ fileName: 'a' }, { fileName: 'b' }]);
                expect(second).toEqual([{ fileName: 'b' }, { fileName: 'a' }]);
            });
        });

        // ── E. Provider policy: no schema → no structured-output gate → uniform zoo ──
        describe('E. provider policy (parse path is provider-independent)', () => {
            // The single-object drop (row 3) must behave IDENTICALLY whether the
            // slot is a strict-json_schema provider or a json_object-fallback
            // one, because this boundary never passes a schema and so never hits
            // the gate. Pinned as the CORRECT (recover) behavior under both.
            for (const provider of ['anthropic', 'moonshotai', 'kimi', 'z-ai']) {
                it.failing(
                    `row 3 under ${provider} — single object should recover to a 1-element array (SILENT DROP today)`,
                    async () => {
                        mockRun(JSON.stringify({ fileName: 'src/a.ts' }));
                        const out = await svc.detectReferences(
                            baseParams({
                                byokConfig: { provider, model: 'm' } as any,
                            }) as any,
                        );
                        expect(out).toEqual([{ fileName: 'src/a.ts' }]);
                    },
                );
            }
        });

        // ── Return-shape invariant: ALWAYS an array across the non-throwing zoo ──
        describe('always returns an array (declared type invariant)', () => {
            it.each([
                ['exact array', '[{"fileName":"a"}]'],
                ['empty array', '[]'],
                ['object', '{"fileName":"a"}'],
                ['empty object', '{}'],
                ['primitive', 'true'],
                ['null', null],
                ['empty string', ''],
                ['refusal prose', 'I cannot help.'],
                ['truncated', '[{"fileName":'],
                ['wrapper', '{"result":[{"fileName":"a"}]}'],
            ])(
                'returns an array for %s',
                async (_label, value) => {
                    mockRun(value);
                    const out = await svc.detectReferences(baseParams() as any);
                    expect(Array.isArray(out)).toBe(true);
                },
            );
        });
    });

    describe('extractMarkers', () => {
        it('collects the originalText of each provided reference', () => {
            const out = svc.extractMarkers('', [
                { originalText: '@ref.ts' } as any,
            ]);
            expect(out).toContain('@ref.ts');
        });

        it('extracts @file markers written in the prompt text', () => {
            expect(svc.extractMarkers('here is @src/utils.ts', [])).toContain(
                '@src/utils.ts',
            );
        });

        it('filters out Kodus control markers (@kody-sync / @kody-ignore)', () => {
            // both match the @-token regex but must NOT be treated as file refs
            expect(svc.extractMarkers('@kody-sync and @kody-ignore', [])).toEqual(
                [],
            );
        });

        it('extracts full MCP markers @mcp<app|tool>', () => {
            expect(svc.extractMarkers('call @mcp<github|search>', [])).toContain(
                '@mcp<github|search>',
            );
        });

        it('de-duplicates a marker that comes from BOTH a reference and the text', () => {
            const out = svc.extractMarkers('touching @dup.ts', [
                { originalText: '@dup.ts' } as any,
            ]);
            expect(out.filter((m) => m === '@dup.ts')).toHaveLength(1);
        });
    });
});
