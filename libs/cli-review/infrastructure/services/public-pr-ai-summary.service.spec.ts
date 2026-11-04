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
    });

    // ═══ A. Output-shape zoo ═══════════════════════════════════════════════

    // NON-string returns violate the text contract → `.trim()` throws → observable fail-safe (undefined + warn).
    const nonStringRows: Array<[string, unknown]> = [
        ['row2 bare array', ['a', 'b']],
        ['row17a null', null],
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

    // ═══ D. Input variants ═════════════════════════════════════════════════

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

    // Row 39 — input item with null/undefined required field
    it('[row39] pr without an author → the Author line is omitted, no crash', async () => {
        happy();
        const noAuthor = { ...fullPr, author: undefined };
        const out = await svc.generate(noAuthor, 'd');
        const { user } = runSpy.mock.calls[0][0];
        expect(user).not.toContain('Author:');
        expect(out).toBe('ok summary');
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

});
