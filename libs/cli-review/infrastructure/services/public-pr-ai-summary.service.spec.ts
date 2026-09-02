import { LLM } from '@libs/llm/llm';
import { LLM_TASK } from '@libs/llm/byok-config';
import { PublicPrAiSummaryService } from './public-pr-ai-summary.service';

/**
 * Thin wrapper over the model, but the two contracts that matter for a PUBLIC
 * demo page are worth pinning: an empty/whitespace generation collapses to
 * undefined (so the UI shows nothing rather than a blank box), and any model
 * error degrades to undefined instead of crashing the page.
 */
describe('PublicPrAiSummaryService.generate — trim & fail-safe', () => {
    const svc = new PublicPrAiSummaryService();
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

    it('returns the trimmed summary text', async () => {
        runSpy.mockResolvedValue('  a summary  ');
        expect(await svc.generate(pr, 'diff')).toBe('a summary');
    });

    it('returns undefined when the model produced only whitespace', async () => {
        runSpy.mockResolvedValue('   ');
        expect(await svc.generate(pr, 'diff')).toBeUndefined();
    });

    it('is fail-safe: a model error yields undefined (never crashes the demo page)', async () => {
        runSpy.mockRejectedValue(new Error('model down'));
        expect(await svc.generate(pr, 'diff')).toBeUndefined();
    });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * LLM.run I/O CONTRACT MATRIX — public-pr-ai-summary boundary
 *
 * This boundary is a TEXT consumer, not a structured/schema consumer:
 *   `LLM.run({ task, defaultModelOverride, user, ... })` is called WITHOUT a
 *   `schema`, so its declared output `D` is a plain `string` (see llm.ts text
 *   overload). The service's whole deterministic layer is:
 *       return text.trim() || undefined;   // inside try/catch → undefined
 *
 * Consequences for the matrix:
 *  - Any string the model emits is, by contract, a VALID `D` — the boundary
 *    does not interpret/parse it (it's markdown shown to a visitor). Stringified
 *    JSON, markdown fences, prose, unicode, truncated partials → returned as-is
 *    (only OUTER whitespace trimmed).
 *  - Any NON-string value resolved by LLM.run violates the text contract; the
 *    boundary hits `(<non-string>).trim()` which throws, the catch logs a warn
 *    and returns `undefined`. That is the DOCUMENTED, OBSERVABLE fail-safe
 *    (typed-empty + log) — NOT a #1786 silent keep-all/drop. So these rows are
 *    asserted with `it` (real behavior), not `it.failing`.
 *  - JSON-field-shaped rows (wrong keys, boolean encodings, enum, index range,
 *    dup keys, malformed/truncated JSON, provider structured-gate policy) have
 *    no surface here — there is no schema, no parse layer, no structured-output
 *    gate at this boundary (all of that lives inside LLM.run). Those go to
 *    rowsNA.
 *
 * The single LLM.run site: public-pr-ai-summary.service.ts:38.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('PublicPrAiSummaryService — LLM.run I/O contract matrix', () => {
    const svc = new PublicPrAiSummaryService();
    const fullPr = {
        owner: 'octo',
        repo: 'demo',
        prNumber: 42,
        title: 'Add retries',
        author: { login: 'alice' },
        baseRef: 'main',
        headRef: 'feature',
        additions: 10,
        deletions: 2,
        changedFiles: 3,
    } as any;
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
        runSpy = jest.spyOn(LLM, 'run');
    });

    afterEach(() => jest.restoreAllMocks());

    // The single reusable happy mock: returns a plain string (valid D).
    const happy = (text = 'ok summary') =>
        runSpy.mockResolvedValue(text as any);

    // ── Request assembly (deterministic layer): exact args, no schema, no BYOK
    describe('request assembly', () => {
        it('threads the exact fixed-tuning args and NO schema / NO byokConfig', async () => {
            happy();
            await svc.generate(fullPr, 'my diff');

            expect(runSpy).toHaveBeenCalledTimes(1);
            const req = runSpy.mock.calls[0][0];
            expect(req.task).toBe(LLM_TASK.prSummary);
            expect(req.defaultModelOverride).toBe('gemini-3-flash-preview');
            expect(req.temperature).toBe(0.2);
            expect(req.maxOutputTokens).toBe(600);
            expect(req.runName).toBe('public-pr-ai-summary');
            expect(typeof req.user).toBe('string');
            // text call: never carries a schema, never a system turn here
            expect(req.schema).toBeUndefined();
            expect(req.system).toBeUndefined();
            // public demo: no pre-resolved slot, no org routing config
            expect(req.byokConfig).toBeUndefined();
            expect(req.config).toBeUndefined();
        });

        it('embeds the diff verbatim inside a ```diff fence in the user turn', async () => {
            happy();
            await svc.generate(fullPr, 'const x = 1;');
            const { user } = runSpy.mock.calls[0][0];
            expect(user).toContain('```diff');
            expect(user).toContain('const x = 1;');
            expect(user).toContain('octo/demo#42');
        });

        it('ALWAYS returns Promise<string | undefined> — never leaks the raw run value', async () => {
            happy('  trimmed me  ');
            const out = await svc.generate(fullPr, 'd');
            expect(typeof out === 'string' || out === undefined).toBe(true);
            expect(out).toBe('trimmed me');
        });
    });

    // ═══ A. Output-shape zoo ═══════════════════════════════════════════════

    // Row 1 — exact D (a correct plain string)
    it('[row1] exact D (plain string) → trimmed and returned', async () => {
        happy('  A concise summary.  ');
        expect(await svc.generate(fullPr, 'd')).toBe('A concise summary.');
    });

    // Rows 2-6, 14, 15, 17, 18, 19 — NON-string returns violate the text
    // contract → `.trim()` throws → observable fail-safe (undefined + warn).
    const nonStringRows: Array<[string, unknown]> = [
        ['row2 bare array', ['a', 'b']],
        ['row3 single object where string expected', { text: 'hi' }],
        ['row4 wrapper key {result:D}', { result: 'hi' }],
        ['row5 double wrapper {result:{result:D}}', { result: { result: 'hi' } }],
        ['row6 opaque single-key wrap {content:D}', { content: 'hi' }],
        ['row14 empty object', {}],
        ['row15 empty array', []],
        ['row17a null', null],
        ['row17b undefined', undefined],
        ['row18a primitive boolean true', true],
        ['row18b primitive number 0', 0],
        ['row19 provider envelope leak', { choices: [{ message: { content: 'hi' } }] }],
        ['row31 error object instead of throwing', { error: 'boom' }],
    ];
    it.each(nonStringRows)(
        '[%s] non-string LLM.run value → fail-safe undefined + warn (never shipped as text)',
        async (_label, value) => {
            runSpy.mockResolvedValue(value as any);
            const warnSpy = jest.spyOn((svc as any).logger, 'warn');
            const out = await svc.generate(fullPr, 'd');
            expect(out).toBeUndefined();
            expect(warnSpy).toHaveBeenCalledTimes(1);
        },
    );

    // Rows 7-9 — string-shaped "wrong" outputs are, for a TEXT boundary, valid
    // D: returned verbatim (only outer whitespace trimmed). No parse/unwrap.
    it('[row7] stringified JSON is a valid string → returned as-is', async () => {
        happy('{"key":"value"}');
        expect(await svc.generate(fullPr, 'd')).toBe('{"key":"value"}');
    });
    it('[row8] markdown-fenced text → returned as-is (prompt asks for markdown)', async () => {
        happy('```json\n{"a":1}\n```');
        expect(await svc.generate(fullPr, 'd')).toBe('```json\n{"a":1}\n```');
    });
    it('[row9] prose-wrapped text → returned as-is (no de-prosing at a text boundary)', async () => {
        happy('  Here is the result: all good.  ');
        expect(await svc.generate(fullPr, 'd')).toBe(
            'Here is the result: all good.',
        );
    });

    // Row 16 — empty / whitespace-only string → typed-empty undefined
    it('[row16] whitespace-only string → undefined (UI shows nothing, not a blank box)', async () => {
        happy('\n\t   \n');
        expect(await svc.generate(fullPr, 'd')).toBeUndefined();
    });

    // Row 27 — unicode / emoji inside the string must survive intact
    it('[row27] unicode / emoji / escaped newlines inside the text survive intact', async () => {
        happy('Añadió çhecks ✅ 日本語\\n literal');
        expect(await svc.generate(fullPr, 'd')).toBe(
            'Añadió çhecks ✅ 日本語\\n literal',
        );
    });

    // ═══ C. Unparseable / transport (fail-safe layer) ══════════════════════

    // Row 28 — output truncated by maxOutputTokens: a non-empty partial STRING
    // is still valid free-text → returned as-is (no repair layer needed).
    it('[row28] truncated-but-non-empty text (max_tokens cut) → returned as-is', async () => {
        happy('One paragraph then a cut-off bul');
        expect(await svc.generate(fullPr, 'd')).toBe(
            'One paragraph then a cut-off bul',
        );
    });

    // Row 30 — LLM.run throws (network/timeout/abort-rejection) → fail-safe
    it('[row30] LLM.run rejection → undefined, never throws past the boundary', async () => {
        runSpy.mockRejectedValue(new Error('ETIMEDOUT'));
        await expect(svc.generate(fullPr, 'd')).resolves.toBeUndefined();
    });

    // Row 31 — asserted in the non-string it.each above ({error:...} object).

    // Row 32 — empty-success (content:'') → undefined
    it('[row32] empty-success (content: "") → undefined', async () => {
        happy('');
        expect(await svc.generate(fullPr, 'd')).toBeUndefined();
    });

    // Row 33 — refusal prose. A refusal is a NON-EMPTY STRING; a text boundary
    // has no refusal classifier (that is model-quality / the eval track, out of
    // scope), so it returns the string. Pinned as REAL behavior so the contract
    // is explicit: this boundary does not detect refusals.
    it('[row33] refusal prose is a valid string → returned as-is (no content classifier here)', async () => {
        happy('I cannot help with that request.');
        expect(await svc.generate(fullPr, 'd')).toBe(
            'I cannot help with that request.',
        );
    });

    // ═══ D. Input variants ═════════════════════════════════════════════════

    // Row 35 — empty input (empty diff) still assembles a request and returns
    it('[row35] empty diff → still calls the model once and returns its text', async () => {
        happy('summary of an empty diff');
        const out = await svc.generate(fullPr, '');
        expect(runSpy).toHaveBeenCalledTimes(1);
        const { user } = runSpy.mock.calls[0][0];
        expect(user).toContain('```diff');
        // no truncation note for a small diff
        expect(user).not.toContain('the diff is large');
        expect(out).toBe('summary of an empty diff');
    });

    // Row 36 — single small item
    it('[row36] single small diff → passes through verbatim in the user turn', async () => {
        happy();
        await svc.generate(fullPr, '+ added one line');
        expect(runSpy.mock.calls[0][0].user).toContain('+ added one line');
    });

    // Row 37 — large input crossing the truncation boundary
    it('[row37] diff larger than MAX_DIFF_CHARS → truncated to 60k + truncation note', async () => {
        happy();
        const big = 'x'.repeat(60_000 + 500);
        await svc.generate(fullPr, big);
        const { user } = runSpy.mock.calls[0][0];
        expect(user).toContain('the diff is large');
        // only the first 60k chars of the diff are embedded
        expect(user).toContain('x'.repeat(60_000));
        expect(user).not.toContain('x'.repeat(60_000 + 1));
    });

    // Row 38 — duplicate items in input are passed through, not deduped
    it('[row38] duplicate diff content is not deduped → passed through verbatim', async () => {
        happy();
        const dup = '+ same line\n+ same line\n+ same line';
        await svc.generate(fullPr, dup);
        const { user } = runSpy.mock.calls[0][0];
        expect(user.split('+ same line').length - 1).toBe(3);
    });

    // Row 39 — input item with null/undefined required field
    it('[row39] pr without an author → the Author line is omitted, no crash', async () => {
        happy();
        const noAuthor = { ...fullPr, author: undefined };
        const out = await svc.generate(noAuthor, 'd');
        const { user } = runSpy.mock.calls[0][0];
        expect(user).not.toContain('Author:');
        expect(out).toBe('ok summary');
    });

    it('[row39b] pr with an undefined title still assembles a request without throwing', async () => {
        happy();
        const noTitle = { ...fullPr, title: undefined };
        await expect(svc.generate(noTitle, 'd')).resolves.toBe('ok summary');
        expect(runSpy).toHaveBeenCalledTimes(1);
    });

    // Row 40 — special chars / whitespace-only diff pass through
    it('[row40a] special chars & backtick fences in the diff pass through verbatim', async () => {
        happy();
        const nasty = '``` weird ```\n binary\tTAB — em-dash 🎯';
        await svc.generate(fullPr, nasty);
        expect(runSpy.mock.calls[0][0].user).toContain(nasty);
    });
    it('[row40b] whitespace-only diff → still calls the model, no truncation note', async () => {
        happy('sum');
        await svc.generate(fullPr, '    \n\t  ');
        const { user } = runSpy.mock.calls[0][0];
        expect(user).not.toContain('the diff is large');
        expect(runSpy).toHaveBeenCalledTimes(1);
    });

    // Row 41 — off-by-one at the MAX_DIFF_CHARS boundary
    it('[row41] diff length exactly MAX_DIFF_CHARS → NOT flagged truncated (> is strict)', async () => {
        happy();
        await svc.generate(fullPr, 'y'.repeat(60_000));
        expect(runSpy.mock.calls[0][0].user).not.toContain('the diff is large');
    });
    it('[row41b] diff length MAX_DIFF_CHARS + 1 → flagged truncated', async () => {
        happy();
        await svc.generate(fullPr, 'y'.repeat(60_001));
        expect(runSpy.mock.calls[0][0].user).toContain('the diff is large');
    });

    // Row 42 — order permutation of the same input → equivalent assembled prompt
    it('[row42] pr field insertion order does not change the assembled user prompt (metamorphic)', async () => {
        happy();
        const a = {
            owner: 'octo',
            repo: 'demo',
            prNumber: 42,
            title: 'Add retries',
            author: { login: 'alice' },
            baseRef: 'main',
            headRef: 'feature',
            additions: 10,
            deletions: 2,
            changedFiles: 3,
        } as any;
        // same fields, reversed insertion order
        const b = {
            changedFiles: 3,
            deletions: 2,
            additions: 10,
            headRef: 'feature',
            baseRef: 'main',
            author: { login: 'alice' },
            title: 'Add retries',
            prNumber: 42,
            repo: 'demo',
            owner: 'octo',
        } as any;

        await svc.generate(a, 'same diff');
        const userA = runSpy.mock.calls[0][0].user;
        runSpy.mockClear();
        happy();
        await svc.generate(b, 'same diff');
        const userB = runSpy.mock.calls[0][0].user;

        expect(userA).toBe(userB);
    });
});
