import { evaluateApprovalFileConditions as evaluate } from './approval-file-conditions';

const file = (filename: string, additions = 1, deletions = 1) => ({
    filename,
    additions,
    deletions,
});

it('keeps two file scopes separate for non-overlapping policy conditions', () => {
    expect(
        evaluate({ includedFiles: ['docs/**'] }, [file('docs/readme.md')])
            .matches,
    ).toBe(true);
    expect(
        evaluate({ includedFiles: ['package.json', 'yarn.lock'] }, [
            file('docs/readme.md'),
        ]).matches,
    ).toBe(false);
    expect(
        evaluate({ includedFiles: ['docs/**'] }, [file('package.json')])
            .matches,
    ).toBe(false);
    expect(
        evaluate({ includedFiles: ['package.json', 'yarn.lock'] }, [
            file('package.json'),
        ]).matches,
    ).toBe(true);
});

it('requires every changed path to match includes', () => {
    expect(
        evaluate({ includedFiles: ['docs/**'] }, [
            file('docs/readme.md'),
            file('src/auth.ts'),
        ]),
    ).toMatchObject({ matches: false, code: 'outside-included-files' });
});

it('rejects a rename into an included directory when the original path is outside', () => {
    expect(
        evaluate({ includedFiles: ['docs/**'] }, [
            {
                ...file('docs/old/tax.ts'),
                previous_filename: 'src/billing/tax.ts',
                status: 'renamed',
            },
        ]),
    ).toMatchObject({ matches: false, code: 'outside-included-files' });
});

it.each(['src/auth/**', 'docs/**'])(
    'matches excludes against either rename path (%s)',
    (pattern) => {
        expect(
            evaluate({ excludedFiles: [pattern] }, [
                {
                    ...file('docs/guard.ts'),
                    previous_filename: 'src/auth/guard.ts',
                },
            ]),
        ).toMatchObject({ matches: false, code: 'excluded-file' });
    },
);

it('counts deletions as changed paths and changed lines', () => {
    const removed = { ...file('src/auth/guard.ts', 0, 20), status: 'removed' };
    expect(evaluate({ includedFiles: ['docs/**'] }, [removed]).matches).toBe(
        false,
    );
    expect(
        evaluate({ excludedFiles: ['src/auth/**'] }, [removed]).matches,
    ).toBe(false);
    expect(evaluate({ maxChangedLines: 19 }, [removed])).toMatchObject({
        matches: false,
        code: 'line-limit-exceeded',
    });
});

it('counts additions plus deletions while omitting configured line-count exclusions', () => {
    expect(
        evaluate(
            { maxChangedLines: 10, lineCountExcludedFiles: ['yarn.lock'] },
            [file('src/a.ts', 6, 4), file('yarn.lock', 200, 300)],
        ),
    ).toEqual({ matches: true, countedLines: 10 });
    expect(
        evaluate({ maxChangedLines: 9 }, [file('src/a.ts', 6, 4)]).matches,
    ).toBe(false);
});

it('does not hide a code change by moving it out of a line-count exclusion', () => {
    expect(
        evaluate(
            { maxChangedLines: 5, lineCountExcludedFiles: ['yarn.lock'] },
            [{ ...file('src/code.ts', 6, 0), previous_filename: 'yarn.lock' }],
        ),
    ).toMatchObject({ matches: false, code: 'line-limit-exceeded' });
});

it('keeps brace globs intact as array elements', () => {
    expect(
        evaluate({ includedFiles: ['src/**/*.{ts,tsx}'] }, [file('src/a.tsx')])
            .matches,
    ).toBe(true);
});

it('does not require provider file data for a policy with no file condition', () => {
    expect(evaluate({}, undefined)).toEqual({ matches: true });
});

it.each([
    [undefined, undefined, false],
    [false, undefined, false],
    [true, true, false],
    [true, false, true],
])(
    'requires verified text evidence for a patchless zero-count rename (verified=%s, binary=%s)',
    (lineCountVerified, isBinary, matches) => {
        expect(
            evaluate({ maxChangedLines: 10 }, [
                {
                    filename: 'assets/new.bin',
                    previous_filename: 'assets/old.bin',
                    status: 'renamed',
                    additions: 0,
                    deletions: 0,
                    lineCountVerified,
                    isBinary,
                },
            ]),
        ).toMatchObject(
            matches
                ? { matches: true, countedLines: 0 }
                : { matches: false, code: 'line-count-unavailable' },
        );
    },
);
