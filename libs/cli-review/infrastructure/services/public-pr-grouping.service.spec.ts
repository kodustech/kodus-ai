import { LLM } from '@libs/llm/llm';
import { LLM_TASK } from '@libs/llm/byok-config';
import { PublicPrGroupingService } from './public-pr-grouping.service';

/**
 * The model proposes file groups; this service defends the result before it
 * reaches the UI: it drops hallucinated paths (files not in the PR), keeps each
 * file in exactly one group, collects anything unassigned into a synthetic
 * "Other changes" group, and degrades to undefined on any failure. Those
 * defenses are the deterministic contract pinned here (the model call is stubbed).
 */
describe('PublicPrGroupingService.generate — post-LLM defense', () => {
    const svc = new PublicPrGroupingService();
    const pr = {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        title: 't',
        baseRef: 'main',
        headRef: 'x',
    } as any;
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
        runSpy = jest.spyOn(LLM, 'run');
    });

    afterEach(() => jest.restoreAllMocks());

    it('skips grouping (no model call) for a PR with fewer than 2 files', async () => {
        expect(await svc.generate(pr, 'diff', [])).toBeUndefined();
        expect(await svc.generate(pr, 'diff', ['only.ts'])).toBeUndefined();
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('drops hallucinated file paths that were not in the PR', async () => {
        runSpy.mockResolvedValue({
            groups: [
                { title: 'A', explanation: 'e', files: ['a.ts', 'invented.ts'] },
            ],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts']);

        expect(out?.[0].files).toEqual(['a.ts']); // invented.ts dropped
        expect(out?.find((g) => g.title === 'Other changes')?.files).toEqual([
            'b.ts',
        ]);
    });

    it('assigns each file to only the FIRST group that claims it', async () => {
        runSpy.mockResolvedValue({
            groups: [
                { title: 'First', explanation: 'e', files: ['a.ts'] },
                { title: 'Second', explanation: 'e', files: ['a.ts', 'b.ts'] },
            ],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts']);

        expect(out?.find((g) => g.title === 'First')?.files).toEqual(['a.ts']);
        expect(out?.find((g) => g.title === 'Second')?.files).toEqual(['b.ts']); // a.ts not duplicated
    });

    it('drops a group left empty after filtering, and trims titles/explanations', async () => {
        runSpy.mockResolvedValue({
            groups: [
                { title: '  Real  ', explanation: '  desc  ', files: ['a.ts', 'b.ts'] },
                { title: 'Empty', explanation: 'e', files: ['invented.ts'] },
            ],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts']);

        expect(out).toHaveLength(1); // Empty dropped, no leftovers → just Real
        expect(out?.[0]).toMatchObject({
            title: 'Real',
            explanation: 'desc',
            files: ['a.ts', 'b.ts'],
        });
    });

    it('collects real files that no group claimed into an "Other changes" group', async () => {
        runSpy.mockResolvedValue({
            groups: [{ title: 'A', explanation: 'e', files: ['a.ts'] }],
        });

        const out = await svc.generate(pr, 'diff', ['a.ts', 'b.ts', 'c.ts']);

        expect(out?.find((g) => g.title === 'Other changes')?.files).toEqual([
            'b.ts',
            'c.ts',
        ]);
    });

    it('is fail-safe: an LLM error yields undefined (no grouping rather than a crash)', async () => {
        runSpy.mockRejectedValue(new Error('model down'));
        expect(await svc.generate(pr, 'diff', ['a.ts', 'b.ts'])).toBeUndefined();
    });
});

/**
 * ── LLM.run I/O contract matrix (see scratchpad/llm-io-contract-matrix.md) ──
 *
 * The ONE LLM.run site in this file is `generate` (public-pr-grouping.service.ts:83).
 * Declared schema D = `{ groups: Array<{ title, explanation, files: string[] }> }`
 * (`GroupingSchema`, min 1 / max 8 groups). This boundary does NOT parse
 * envelopes itself — it passes `schema` to LLM.run and directly consumes
 * `object.groups`. Structured-output / provider policy therefore lives INSIDE
 * LLM.run (structured-output-gate + structured-review-call), which these tests
 * stub. So the deterministic contract owned HERE is:
 *   1. request assembly — exact args / schema / task / overrides threaded to LLM.run;
 *   2. off-schema tolerance — any shape that is not `{groups:[...]}` must
 *      RECOVER or fail to the OBSERVABLE safe-default (undefined → UI tree
 *      fallback + warn log), never crash past the boundary;
 *   3. the guaranteed return type — `PublicPrGrouping[] | undefined` in every layer.
 *
 * We do NOT assert model decision QUALITY (whether the grouping is "good") — that
 * is the eval track, out of scope.
 */
describe('PublicPrGroupingService.generate — LLM.run I/O contract', () => {
    const svc = new PublicPrGroupingService();
    const pr = {
        owner: 'acme',
        repo: 'widget',
        prNumber: 42,
        title: 'Refactor tool reference',
        baseRef: 'main',
        headRef: 'feature',
    } as any;
    let runSpy: jest.SpyInstance;

    const goodGroups = (files: string[]) => ({
        groups: [{ title: 'A', explanation: 'does a thing', files }],
    });

    beforeEach(() => {
        jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
        runSpy = jest.spyOn(LLM, 'run');
    });

    afterEach(() => jest.restoreAllMocks());

    // ───────────────────────────────────────────────────────────────────────
    // Request assembly — the deterministic INPUT contract to LLM.run.
    // (Covers the byokConfig-threading scope: public demo → NO byokConfig, the
    //  forced cheaper default rides as `defaultModelOverride`.)
    // ───────────────────────────────────────────────────────────────────────
    describe('request assembly', () => {
        it('threads the exact task / model override / tuning / runName to LLM.run', async () => {
            runSpy.mockResolvedValue(goodGroups(['a.ts', 'b.ts']));

            await svc.generate(pr, 'the diff', ['a.ts', 'b.ts']);

            expect(runSpy).toHaveBeenCalledTimes(1);
            const args = runSpy.mock.calls[0][0];
            expect(args.task).toBe(LLM_TASK.prSummary);
            expect(args.defaultModelOverride).toBe('gemini-3-flash-preview');
            expect(args.runName).toBe('public-pr-grouping');
            expect(args.temperature).toBe(0.15);
            expect(args.maxOutputTokens).toBe(4000);
            expect(args.providerOptions).toEqual({
                google: { thinkingConfig: { thinkingBudget: 0 } },
            });
            // Public demo path: no pre-resolved slot is threaded — LLM.run
            // resolves the managed default from the override.
            expect(args.byokConfig).toBeUndefined();
            expect(args.config).toBeUndefined();
        });

        it('passes the declared schema D (accepts a valid grouping, rejects empty groups)', async () => {
            runSpy.mockResolvedValue(goodGroups(['a.ts', 'b.ts']));

            await svc.generate(pr, 'the diff', ['a.ts', 'b.ts']);

            const schema = runSpy.mock.calls[0][0].schema;
            expect(schema).toBeDefined();
            expect(
                schema.safeParse({
                    groups: [{ title: 't', explanation: 'e', files: ['a.ts'] }],
                }).success,
            ).toBe(true);
            // min(1): the empty-groups shape is rejected by D itself.
            expect(schema.safeParse({ groups: [] }).success).toBe(false);
        });

        it('embeds pr metadata + every changed file into the user prompt', async () => {
            runSpy.mockResolvedValue(goodGroups(['src/a.ts', 'src/b.ts']));

            await svc.generate(pr, 'DIFF-BODY', ['src/a.ts', 'src/b.ts']);

            const user: string = runSpy.mock.calls[0][0].user;
            expect(user).toContain('acme/widget#42');
            expect(user).toContain('Refactor tool reference');
            expect(user).toContain('main ← feature');
            expect(user).toContain('- src/a.ts');
            expect(user).toContain('- src/b.ts');
            expect(user).toContain('DIFF-BODY');
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // A. Output-shape zoo — rows 1..20.
    // This boundary does no envelope recovery, so any shape that is not
    // `{groups:[...]}` degrades to the OBSERVABLE safe-default (undefined +
    // warn). That satisfies the non-degradation rule (explicit, signalled).
    // ───────────────────────────────────────────────────────────────────────
    describe('A. output-shape zoo', () => {
        const files = ['a.ts', 'b.ts'];

        it('row 1 — exact D: parses and returns the grouping verbatim', async () => {
            runSpy.mockResolvedValue({
                groups: [
                    { title: 'Grp', explanation: 'expl', files: ['a.ts', 'b.ts'] },
                ],
            });
            const out = await svc.generate(pr, 'd', files);
            expect(out).toEqual([
                { title: 'Grp', explanation: 'expl', files: ['a.ts', 'b.ts'] },
            ]);
        });

        it('row 2 — bare array (no `groups` wrapper): safe-default undefined', async () => {
            runSpy.mockResolvedValue([
                { title: 'A', explanation: 'e', files: ['a.ts', 'b.ts'] },
            ]);
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 3 — single object where the array is expected: safe-default undefined', async () => {
            runSpy.mockResolvedValue({
                groups: { title: 'A', explanation: 'e', files: ['a.ts'] },
            });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 4 — wrapper key {result:D} / {data:D}: safe-default undefined', async () => {
            runSpy.mockResolvedValueOnce({ result: goodGroups(files) });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
            runSpy.mockResolvedValueOnce({ data: goodGroups(files) });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 5 — double wrapper {result:{result:D}}: safe-default undefined', async () => {
            runSpy.mockResolvedValue({ result: { result: goodGroups(files) } });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 6 — numeric/opaque single-key wrap {"0":D}/{content:D}: safe-default undefined', async () => {
            runSpy.mockResolvedValueOnce({ 0: goodGroups(files) });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
            runSpy.mockResolvedValueOnce({ content: goodGroups(files) });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 7 — stringified JSON of D: safe-default undefined', async () => {
            runSpy.mockResolvedValue(JSON.stringify(goodGroups(files)));
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 8 — markdown-fenced JSON string: safe-default undefined', async () => {
            runSpy.mockResolvedValue(
                '```json\n' + JSON.stringify(goodGroups(files)) + '\n```',
            );
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 9 — prose-wrapped JSON string: safe-default undefined', async () => {
            runSpy.mockResolvedValue(
                'Here is the result: ' + JSON.stringify(goodGroups(files)),
            );
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 10 — right data, wrong keys (renamed wrapper): safe-default undefined', async () => {
            runSpy.mockResolvedValue({
                clusters: [{ title: 'A', explanation: 'e', files: ['a.ts'] }],
            });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 11 — case/convention mismatch on the wrapper key: safe-default undefined', async () => {
            runSpy.mockResolvedValue({
                Groups: [{ title: 'A', explanation: 'e', files: ['a.ts'] }],
            });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 12 — partial group object (missing `files`): safe-default undefined', async () => {
            runSpy.mockResolvedValue({
                groups: [{ title: 'A', explanation: 'e' }],
            });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 13 — extra unknown keys are tolerated (not crash), real keys used', async () => {
            runSpy.mockResolvedValue({
                groups: [
                    {
                        title: 'A',
                        explanation: 'e',
                        files: ['a.ts', 'b.ts'],
                        confidence: 0.9,
                        extra: { junk: true },
                    },
                ],
                usage: { tokens: 10 },
            });
            const out = await svc.generate(pr, 'd', files);
            expect(out).toEqual([
                { title: 'A', explanation: 'e', files: ['a.ts', 'b.ts'] },
            ]);
        });

        it('row 14 — empty object {}: safe-default undefined', async () => {
            runSpy.mockResolvedValue({});
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 15 — empty groups array {groups:[]}: collapses every file into a single observable "Other changes" group', async () => {
            // Not a silent #1786 degradation: the result is explicitly titled
            // "Other changes" (the documented leftover bucket), so the empty
            // grouping is observable to the UI rather than shipped as a real
            // clustering. (In prod, GroupingSchema.min(1) also rejects this
            // upstream inside LLM.run before it reaches here.)
            runSpy.mockResolvedValue({ groups: [] });
            const out = await svc.generate(pr, 'd', files);
            expect(out).toEqual([
                {
                    title: 'Other changes',
                    explanation:
                        "Smaller follow-ups that don't cluster with the rest.",
                    files: ['a.ts', 'b.ts'],
                },
            ]);
        });

        it('row 16 — empty / whitespace-only string: safe-default undefined', async () => {
            runSpy.mockResolvedValueOnce('');
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
            runSpy.mockResolvedValueOnce('   \n\t ');
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 17 — null / undefined return: safe-default undefined', async () => {
            runSpy.mockResolvedValueOnce(null);
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
            runSpy.mockResolvedValueOnce(undefined);
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 18 — primitive where object expected (true/0/"ok"): safe-default undefined', async () => {
            for (const v of [true, 0, 'ok']) {
                runSpy.mockResolvedValueOnce(v);
                expect(await svc.generate(pr, 'd', files)).toBeUndefined();
            }
        });

        it('row 19 — provider envelope leak {choices:[{message:{content}}]}: safe-default undefined', async () => {
            runSpy.mockResolvedValue({
                choices: [
                    { message: { content: JSON.stringify(goodGroups(files)) } },
                ],
            });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 20 — reasoning/thinking leak in a string payload: safe-default undefined', async () => {
            runSpy.mockResolvedValue(
                '<thinking>let me cluster these files</thinking>' +
                    JSON.stringify(goodGroups(files)),
            );
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // B. Semantic-but-wrong — rows 21..27.
    // D has no boolean/enum/numeric-index fields (only strings + string[]), so
    // 21..24 are N/A. The applicable analogs: 25 = dangling file reference
    // (hallucinated path), 26 = duplicate file (dedup), 27 = unicode passthrough.
    // ───────────────────────────────────────────────────────────────────────
    describe('B. semantic-but-wrong', () => {
        it('row 25 — dangling file reference (index/path out of range) is dropped, real leftovers rescued', async () => {
            runSpy.mockResolvedValue({
                groups: [
                    {
                        title: 'A',
                        explanation: 'e',
                        // 'z.ts' is a dangling reference — not in the PR.
                        files: ['a.ts', 'z.ts'],
                    },
                ],
            });
            const out = await svc.generate(pr, 'd', ['a.ts', 'b.ts']);
            expect(out?.[0].files).toEqual(['a.ts']); // z.ts dropped
            expect(out?.find((g) => g.title === 'Other changes')?.files).toEqual(
                ['b.ts'],
            );
        });

        // KNOWN DEGRADATION (#1786 class): duplicates ACROSS groups are
        // de-duped (the "FIRST group claims it" test passes), but a file
        // repeated WITHIN one group's `files` array is NOT — the `seen` set is
        // only updated AFTER the per-group `filter`, so both copies survive the
        // same pass and ship silently, with no signal. Correct behavior is one
        // copy. Green today (documents the bug), red once the filter de-dupes
        // intra-group. Source: public-pr-grouping.service.ts:112 (`.filter`) +
        // :115 (`seen` populated only after the filter).
        it.failing(
            'row 26 — duplicate file within one group is de-duplicated (last-wins/first-wins → one copy)',
            async () => {
                runSpy.mockResolvedValue({
                    groups: [
                        {
                            title: 'A',
                            explanation: 'e',
                            files: ['a.ts', 'a.ts', 'b.ts'],
                        },
                    ],
                });
                const out = await svc.generate(pr, 'd', ['a.ts', 'b.ts']);
                expect(out).toHaveLength(1);
                expect(out?.[0].files).toEqual(['a.ts', 'b.ts']); // a.ts once
            },
        );

        it('row 27 — unicode / newlines / emoji in string fields are preserved (only trimmed)', async () => {
            runSpy.mockResolvedValue({
                groups: [
                    {
                        title: '  Café ↔ Ünïcode 🚀  ',
                        explanation: '  handles münchen ✅  ',
                        files: ['a.ts', 'b.ts'],
                    },
                ],
            });
            const out = await svc.generate(pr, 'd', ['a.ts', 'b.ts']);
            expect(out?.[0].title).toBe('Café ↔ Ünïcode 🚀');
            expect(out?.[0].explanation).toBe('handles münchen ✅');
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // C. Unparseable / transport — rows 28..34. The fail-safe layer: LLM.run
    // rejecting (truncation, malformed, network, abort) or handing back an
    // error/empty/refusal shape must degrade to undefined, never throw past
    // the boundary, never drop data silently.
    // ───────────────────────────────────────────────────────────────────────
    describe('C. unparseable / transport (fail-safe)', () => {
        const files = ['a.ts', 'b.ts'];

        it('row 28 — truncated JSON (AI_NoObjectGeneratedError) → undefined', async () => {
            const err = new Error('AI_NoObjectGeneratedError: could not parse');
            (err as any).name = 'AI_NoObjectGeneratedError';
            runSpy.mockRejectedValue(err);
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 29 — malformed JSON rejection → undefined', async () => {
            runSpy.mockRejectedValue(new SyntaxError('Unexpected token } in JSON'));
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 30 — LLM.run throws (network/timeout) → undefined, never past the boundary', async () => {
            runSpy.mockRejectedValue(new Error('ETIMEDOUT'));
            await expect(svc.generate(pr, 'd', files)).resolves.toBeUndefined();
        });

        it('row 31 — error object {error:...} returned (not thrown) → undefined', async () => {
            runSpy.mockResolvedValue({ error: 'rate_limited' });
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 32 — empty success (content:"" / finish_reason:length) → undefined', async () => {
            runSpy.mockResolvedValue('');
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 33 — refusal prose ("I cannot help…") → undefined', async () => {
            runSpy.mockResolvedValue(
                "I'm sorry, I can't help with analyzing this diff.",
            );
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
        });

        it('row 34 — abort rejection is caught → undefined (boundary passes no abortSignal of its own)', async () => {
            const err = new Error('The operation was aborted');
            (err as any).name = 'AbortError';
            runSpy.mockRejectedValue(err);
            expect(await svc.generate(pr, 'd', files)).toBeUndefined();
            // Contract note: this boundary never threads a `signal` into LLM.run.
            const args = runSpy.mock.calls[runSpy.mock.calls.length - 1];
            expect(args).toBeDefined();
        });

        it('always resolves to the declared type (array | undefined) — never rejects', async () => {
            for (const v of [null, {}, [], 'x', 5, { groups: 'nope' }]) {
                runSpy.mockResolvedValueOnce(v as any);
                const out = await svc.generate(pr, 'd', files);
                expect(out === undefined || Array.isArray(out)).toBe(true);
            }
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // D. Input variants — rows 35..42.
    // ───────────────────────────────────────────────────────────────────────
    describe('D. input variants', () => {
        it('row 35 — empty input (0 files): undefined, no model call', async () => {
            expect(await svc.generate(pr, 'd', [])).toBeUndefined();
            expect(runSpy).not.toHaveBeenCalled();
        });

        it('row 36 — single file: undefined, no model call (tree view is enough)', async () => {
            expect(await svc.generate(pr, 'd', ['only.ts'])).toBeUndefined();
            expect(runSpy).not.toHaveBeenCalled();
        });

        it('row 37 — large diff crossing the 80k char boundary: sliced + truncation note in prompt', async () => {
            runSpy.mockResolvedValue(goodGroups(['a.ts', 'b.ts']));
            const big = 'x'.repeat(80_001);
            await svc.generate(pr, big, ['a.ts', 'b.ts']);
            const user: string = runSpy.mock.calls[0][0].user;
            expect(user).toContain('the diff was truncated');
            // Diff body inside the fence is sliced to MAX_DIFF_CHARS (80_000).
            expect(user).not.toContain('x'.repeat(80_001));
            expect(user).toContain('x'.repeat(80_000));
        });

        it('row 38 — duplicate items in the input do not produce duplicate output files', async () => {
            runSpy.mockResolvedValue({
                groups: [{ title: 'A', explanation: 'e', files: ['a.ts'] }],
            });
            const out = await svc.generate(pr, 'd', ['a.ts', 'a.ts', 'b.ts']);
            const all = out!.flatMap((g) => g.files);
            expect(all.filter((f) => f === 'a.ts')).toHaveLength(1);
            expect(all.filter((f) => f === 'b.ts')).toHaveLength(1);
        });

        it('row 39 — input with a null/undefined file entry does not crash; still returns an array', async () => {
            runSpy.mockResolvedValue({
                groups: [{ title: 'A', explanation: 'e', files: ['a.ts'] }],
            });
            const out = await svc.generate(pr, 'd', ['a.ts', null as any]);
            expect(Array.isArray(out)).toBe(true);
            // a.ts grouped; the null entry falls into the leftover bucket unharmed.
            expect(out?.find((g) => g.title === 'A')?.files).toEqual(['a.ts']);
        });

        it('row 40 — special-chars / whitespace-only diff is still sent to the model verbatim', async () => {
            runSpy.mockResolvedValue(goodGroups(['a.ts', 'b.ts']));
            const weird = 'diff --git\n+ ☃️ \\n\t"quote" \u0000 <script>';
            await svc.generate(pr, weird, ['a.ts', 'b.ts']);
            const user: string = runSpy.mock.calls[0][0].user;
            expect(user).toContain(weird);
            expect(user).not.toContain('the diff was truncated');
        });

        it('row 41 — off-by-one at the 80k boundary: exactly 80k is NOT truncated, 80k+1 IS', async () => {
            runSpy.mockResolvedValue(goodGroups(['a.ts', 'b.ts']));

            await svc.generate(pr, 'y'.repeat(80_000), ['a.ts', 'b.ts']);
            expect(runSpy.mock.calls[0][0].user).not.toContain(
                'the diff was truncated',
            );

            runSpy.mockClear();
            runSpy.mockResolvedValue(goodGroups(['a.ts', 'b.ts']));
            await svc.generate(pr, 'y'.repeat(80_001), ['a.ts', 'b.ts']);
            expect(runSpy.mock.calls[0][0].user).toContain(
                'the diff was truncated',
            );
        });

        it('row 42 — order permutation of the input yields an equivalent grouping (metamorphic)', async () => {
            const groups = {
                groups: [
                    { title: 'A', explanation: 'e', files: ['a.ts', 'b.ts'] },
                    { title: 'B', explanation: 'e', files: ['c.ts'] },
                ],
            };
            runSpy.mockResolvedValue(groups);
            const out1 = await svc.generate(pr, 'd', ['a.ts', 'b.ts', 'c.ts']);

            runSpy.mockResolvedValue(groups);
            // Same set, permuted; no leftovers → output is fully determined by
            // the model's group order, so the two runs must be identical.
            const out2 = await svc.generate(pr, 'd', ['c.ts', 'a.ts', 'b.ts']);

            expect(out1).toEqual(out2);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // E. Provider / model matrix — N/A at THIS boundary.
    // `generate` always passes `schema` to LLM.run and never branches on the
    // model/provider: the strict-json_schema vs json_object policy lives inside
    // LLM.run (structured-output-gate.ts, covered by its own spec). The A/B/C
    // rows above already exercise the full off-schema zoo that the json_object
    // fallback branch would surface. Nothing to assert here.
    // ───────────────────────────────────────────────────────────────────────
});
