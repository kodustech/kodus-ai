import {
    HEAVY_LENSES,
    HEAVY_LENS_MAX_FINDINGS,
    buildHeavyLensPrompt,
    focusBlockFor,
    heavyLensDiff,
    heavyLensesFor,
} from './heavy-lenses';

describe('heavy lenses (M3)', () => {
    it('are the nine measured lenses, each with its fixed label', () => {
        expect(HEAVY_LENSES.map((l) => [l.id, l.label])).toEqual([
            ['says-one-thing-does-another', 'bug'],
            ['text-that-ships', 'bug'],
            ['invalid-state-and-concurrency', 'bug'],
            ['value-boundary-and-position', 'bug'],
            ['secret-and-identity', 'security'],
            ['contract-not-followed', 'bug'],
            ['test-does-not-verify', 'bug'],
            ['data-exposure', 'security'],
            ['changed-files-disagree', 'bug'],
        ]);
    });

    it('read every item they name from the shared category text', () => {
        for (const lens of HEAVY_LENSES) {
            expect(focusBlockFor(lens).trim()).not.toBe('');
        }
    });

    it('run only for the categories the team has on', () => {
        expect(
            heavyLensesFor(['bug', 'performance']).map((l) => l.id),
        ).not.toContain('data-exposure');
        expect(heavyLensesFor(['security']).map((l) => l.id)).toEqual([
            'secret-and-identity',
            'data-exposure',
        ]);
        expect(heavyLensesFor(['performance'])).toEqual([]);
        expect(heavyLensesFor(undefined)).toHaveLength(9);
        // Every category off: no lens, not all of them.
        expect(heavyLensesFor([])).toEqual([]);
    });

    it('put the diff first and cap the lens at its findings ceiling', () => {
        const diff = heavyLensDiff(
            [
                {
                    filename: 'src/a.ts',
                    status: 'modified',
                    patchWithLinesStr: '@@ -1 +1 @@\n+x',
                },
                { filename: 'src/empty.ts', status: 'modified', patch: '' },
            ] as any,
            new Map([['src/a.ts', 'critical']]) as any,
        );
        expect(diff).toBe(
            '--- src/a.ts (modified) [CRITICAL] ---\n@@ -1 +1 @@\n+x',
        );

        const prompt = buildHeavyLensPrompt(HEAVY_LENSES[7], diff);
        expect(prompt.startsWith(`<Diffs>\n${diff}\n</Diffs>`)).toBe(true);
        expect(prompt).toContain(`AT MOST ${HEAVY_LENS_MAX_FINDINGS}.`);
        expect(prompt).toContain('"label": "security"');
        expect(prompt).not.toContain('${');
        expect(prompt).toContain('using grep to confirm');
    });

    it('point the evidence rule at the diff when there is no sandbox', () => {
        const prompt = buildHeavyLensPrompt(
            HEAVY_LENSES[0],
            'diff',
            false,
            true,
        );
        expect(prompt).not.toContain('grep to confirm');
        expect(prompt).toContain('only the diff');
    });

    it('tell a lens of a chunked review that it sees one batch, not the whole PR', () => {
        const whole = buildHeavyLensPrompt(HEAVY_LENSES[0], 'diff');
        expect(whole).toContain('The diff above is the whole pull request.');

        const batch = buildHeavyLensPrompt(
            HEAVY_LENSES[0],
            'diff',
            false,
            false,
            {
                index: 2,
                total: 3,
            },
        );
        expect(batch).not.toContain('whole pull request');
        expect(batch).toContain('batch 2 of 3 of this pull request');
        expect(batch).toContain('read that code with the tools');

        const noSandbox = buildHeavyLensPrompt(
            HEAVY_LENSES[0],
            'diff',
            false,
            true,
            {
                index: 1,
                total: 2,
            },
        );
        expect(noSandbox).toContain(
            'Do not report a defect that depends on how code outside',
        );
    });
});
