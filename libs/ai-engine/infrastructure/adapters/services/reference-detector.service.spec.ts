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
        });

        // ── C. Unparseable / transport — the fail-safe layer (rows 28-34) ──
        describe('C. unparseable / transport', () => {
            // Every reply with no recoverable array — empty, primitive, an
            // object, truncated or malformed JSON, an {error} payload, refusal
            // prose — fails safe to [], always an array.
            it('fails safe to [] on every reply with no array in it', async () => {
                for (const value of [
                    '{}',
                    '',
                    '   \n  ',
                    null,
                    undefined,
                    'true',
                    '0',
                    '"ok"',
                    '[{"fileName":"a.ts"',
                    '[{"fileName":"a.ts"},]',
                    "[{'fileName':'a.ts'}]",
                    JSON.stringify({ error: 'model unavailable' }),
                    { error: 'model unavailable' },
                    'I cannot help with that request.',
                ]) {
                    jest.restoreAllMocks();
                    mockRun(value);
                    expect(
                        await svc.detectReferences(baseParams() as any),
                    ).toEqual([]);
                }
            });

            it('row 30 — LLM.run throws: signals explicitly (rejects; no silent []) ', async () => {
                jest.spyOn(LLM, 'run').mockRejectedValue(
                    new Error('network timeout'),
                );
                await expect(
                    svc.detectReferences(baseParams() as any),
                ).rejects.toThrow('network timeout');
            });
        });

        // ── D. Input variants (rows 35-42) ──
        describe('D. input variants', () => {
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

describe('ReferenceDetectorService.detectionFingerprint', () => {
    const svc = new ReferenceDetectorService();
    const base = {
        promptText: 'Follow docs/api.md',
        detectionMode: 'rule' as const,
        context: 'rule' as const,
    };

    it('is stable for the same request', () => {
        expect(svc.detectionFingerprint(base)).toBe(
            svc.detectionFingerprint({ ...base }),
        );
    });

    it('is a sha256 hex digest', () => {
        expect(svc.detectionFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes with the text', () => {
        expect(svc.detectionFingerprint(base)).not.toBe(
            svc.detectionFingerprint({ ...base, promptText: 'Follow docs/v2.md' }),
        );
    });

    it('changes with the mode, whose system prompt differs', () => {
        expect(svc.detectionFingerprint(base)).not.toBe(
            svc.detectionFingerprint({ ...base, detectionMode: 'prompt' }),
        );
    });

    it('changes with the context', () => {
        expect(svc.detectionFingerprint(base)).not.toBe(
            svc.detectionFingerprint({ ...base, context: 'instruction' }),
        );
    });

    it('treats a missing mode and context as their own values', () => {
        const bare = { promptText: base.promptText };
        expect(svc.detectionFingerprint(bare)).not.toBe(
            svc.detectionFingerprint({ ...bare, context: 'rule' }),
        );
    });

    it('ignores control markers the model never sees', () => {
        expect(
            svc.detectionFingerprint({
                ...base,
                promptText: 'Follow docs/api.md @kody-sync',
            }),
        ).toBe(
            svc.detectionFingerprint({ ...base, promptText: 'Follow docs/api.md ' }),
        );
    });
});

describe('ReferenceDetectorService.detectReferencesWithStatus', () => {
    const svc = new ReferenceDetectorService();
    const params = {
        requirementId: 'r',
        promptText: 'Follow docs/api.md',
        organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        detectionMode: 'rule' as const,
    };
    let run: jest.SpyInstance;
    beforeEach(() => {
        run = jest.spyOn(LLM, 'run');
    });
    afterEach(() => run.mockRestore());

    it('an empty reply is not a reliable answer', async () => {
        run.mockResolvedValue('');
        expect(await svc.detectReferencesWithStatus(params as any)).toEqual({
            references: [],
            reliable: false,
        });
    });

    it('a reply that is not a JSON array is not a reliable answer', async () => {
        run.mockResolvedValue('{"filePath":"docs/api.md"}');
        expect(
            (await svc.detectReferencesWithStatus(params as any)).reliable,
        ).toBe(false);
    });

    it('an empty JSON array is a reliable "no references"', async () => {
        run.mockResolvedValue('[]');
        expect(await svc.detectReferencesWithStatus(params as any)).toEqual({
            references: [],
            reliable: true,
        });
    });

    it('detectReferences keeps returning just the references', async () => {
        run.mockResolvedValue('[{"filePath":"docs/api.md"}]');
        expect(await svc.detectReferences(params as any)).toEqual([
            { filePath: 'docs/api.md' },
        ]);
    });
});
