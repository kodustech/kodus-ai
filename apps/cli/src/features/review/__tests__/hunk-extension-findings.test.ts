import { describe, expect, it } from 'vitest';
import {
    coerceSeverity,
    countBySeverity,
    findFile,
    findHunkIndex,
    nextCursor,
    orderFindings,
    parseFindings,
    shortenPath,
    type KodusFinding,
} from '../../../../hunk-extension/kodus/findings.js';

function finding(overrides: Partial<KodusFinding> = {}): KodusFinding {
    return {
        id: 'kodus-0',
        file: 'src/a.ts',
        line: 10,
        endLine: 10,
        severity: 'warning',
        title: 'something',
        ...overrides,
    };
}

describe('orderFindings', () => {
    it('sorts by severity first, then file, then line', () => {
        const ordered = orderFindings([
            finding({
                id: 'info',
                severity: 'info',
                file: 'src/a.ts',
                line: 1,
            }),
            finding({
                id: 'crit',
                severity: 'critical',
                file: 'src/z.ts',
                line: 99,
            }),
            finding({ id: 'warn-b', severity: 'warning', file: 'src/b.ts' }),
            finding({
                id: 'warn-a-late',
                severity: 'warning',
                file: 'src/a.ts',
                line: 50,
            }),
            finding({
                id: 'warn-a-early',
                severity: 'warning',
                file: 'src/a.ts',
                line: 5,
            }),
        ]);

        expect(ordered.map((f) => f.id)).toEqual([
            'crit',
            'warn-a-early',
            'warn-a-late',
            'warn-b',
            'info',
        ]);
    });

    it('does not mutate its input', () => {
        const input = [
            finding({ id: 'a', severity: 'info' }),
            finding({ id: 'b', severity: 'critical' }),
        ];
        orderFindings(input);
        expect(input.map((f) => f.id)).toEqual(['a', 'b']);
    });
});

describe('findFile', () => {
    const files = [
        { id: 'f1', path: 'src/a.ts' },
        { id: 'f2', path: 'packages/core/src/b.ts' },
    ];

    it('matches an exact path', () => {
        expect(findFile(files, 'src/a.ts')?.id).toBe('f1');
    });

    it('matches when the review path is more qualified than the finding', () => {
        expect(findFile(files, 'src/b.ts')?.id).toBe('f2');
    });

    it('matches when the finding is more qualified than the review path', () => {
        expect(findFile([{ id: 'f3', path: 'a.ts' }], 'src/a.ts')?.id).toBe(
            'f3',
        );
    });

    it('returns undefined when nothing matches', () => {
        expect(findFile(files, 'src/missing.ts')).toBeUndefined();
    });

    it('does not match on a partial segment', () => {
        expect(
            findFile([{ id: 'f4', path: 'src/ba.ts' }], 'a.ts'),
        ).toBeUndefined();
    });
});

describe('findHunkIndex', () => {
    const file = {
        id: 'f1',
        path: 'src/a.ts',
        hunks: [
            { index: 0, newRange: [1, 10] as [number, number] },
            { index: 1, newRange: [40, 55] as [number, number] },
        ],
    };

    it('returns the hunk covering the finding line', () => {
        expect(findHunkIndex(file, { line: 45 })).toBe(1);
        expect(findHunkIndex(file, { line: 1 })).toBe(0);
        expect(findHunkIndex(file, { line: 10 })).toBe(0);
    });

    it('falls back to the nearest hunk when the line is outside every span', () => {
        // Kodus reviews whole files; hunk only renders changed spans.
        expect(findHunkIndex(file, { line: 12 })).toBe(0);
        expect(findHunkIndex(file, { line: 38 })).toBe(1);
        expect(findHunkIndex(file, { line: 900 })).toBe(1);
    });

    it('returns null when the file has no hunks', () => {
        expect(
            findHunkIndex({ id: 'f', path: 'p', hunks: [] }, { line: 3 }),
        ).toBeNull();
        expect(findHunkIndex({ id: 'f', path: 'p' }, { line: 3 })).toBeNull();
    });

    it('ignores hunks with no line span', () => {
        const synthesized = {
            id: 'f',
            path: 'p',
            hunks: [
                { index: 0 },
                { index: 1, newRange: [5, 6] as [number, number] },
            ],
        };
        expect(findHunkIndex(synthesized, { line: 5 })).toBe(1);
    });
});

describe('parseFindings', () => {
    it('accepts a well-formed sidecar', () => {
        const parsed = parseFindings({
            version: 1,
            summary: 'two findings',
            findings: [finding({ id: 'a' }), finding({ id: 'b' })],
        });
        expect(parsed.summary).toBe('two findings');
        expect(parsed.findings).toHaveLength(2);
    });

    it('drops entries missing a file or line', () => {
        const parsed = parseFindings({
            version: 1,
            findings: [
                finding({ id: 'ok' }),
                { id: 'no-file', line: 3 },
                { id: 'no-line', file: 'src/a.ts' },
            ],
        });
        expect(parsed.findings.map((f) => f.id)).toEqual(['ok']);
    });

    it('degrades to empty for junk input', () => {
        expect(parseFindings(null).findings).toEqual([]);
        expect(parseFindings('nope').findings).toEqual([]);
        expect(parseFindings({ version: 1 }).findings).toEqual([]);
        expect(parseFindings({ findings: 'not-an-array' }).findings).toEqual(
            [],
        );
    });
});

describe('coerceSeverity', () => {
    it('maps the API vocabulary onto renderable severities', () => {
        expect(coerceSeverity('high')).toBe('error');
        expect(coerceSeverity('HIGH')).toBe('error');
        expect(coerceSeverity('medium')).toBe('warning');
        expect(coerceSeverity('low')).toBe('info');
        expect(coerceSeverity('critical')).toBe('critical');
    });

    it('degrades unknown values to info instead of an undefined glyph', () => {
        expect(coerceSeverity('blocker')).toBe('info');
        expect(coerceSeverity(undefined)).toBe('info');
        expect(coerceSeverity(3)).toBe('info');
    });

    it('is applied by parseFindings so a stale sidecar still sorts sanely', () => {
        const parsed = parseFindings({
            version: 1,
            findings: [
                { ...finding({ id: 'high' }), severity: 'high' },
                { ...finding({ id: 'crit' }), severity: 'critical' },
            ],
        });
        expect(orderFindings(parsed.findings).map((f) => f.id)).toEqual([
            'crit',
            'high',
        ]);
    });
});

describe('shortenPath', () => {
    it('leaves short paths alone', () => {
        expect(shortenPath('src/a.ts', 30)).toBe('src/a.ts');
    });

    it('trims leading segments to fit the budget', () => {
        const short = shortenPath('a/b/c/d/e/file.ts', 14);
        expect(short.length).toBeLessThanOrEqual(14);
        expect(short.endsWith('file.ts')).toBe(true);
        expect(short.startsWith('…/')).toBe(true);
    });

    it('keeps the basename even when it alone exceeds the budget', () => {
        expect(shortenPath('a/b/an-extremely-long-file-name.ts', 8)).toContain(
            'an-extremely-long-file-name.ts',
        );
    });
});

describe('countBySeverity', () => {
    it('tallies each severity present', () => {
        expect(
            countBySeverity([
                finding({ severity: 'critical' }),
                finding({ severity: 'info' }),
                finding({ severity: 'info' }),
            ]),
        ).toEqual({ critical: 1, info: 2 });
    });
});

describe('nextCursor', () => {
    it('starts at the first finding going forward', () => {
        expect(nextCursor(-1, 1, 3)).toBe(0);
    });

    it('starts at the last finding going backward', () => {
        // Regression: the plain modulo gave `length - 2` here, so the first
        // `p` skipped the last finding and only `n` could ever reach it.
        expect(nextCursor(-1, -1, 3)).toBe(2);
        expect(nextCursor(-1, -1, 1)).toBe(0);
    });

    it('wraps in both directions once started', () => {
        expect(nextCursor(2, 1, 3)).toBe(0);
        expect(nextCursor(0, -1, 3)).toBe(2);
        expect(nextCursor(1, 1, 3)).toBe(2);
    });

    it('stays out of the way when there is nothing to walk', () => {
        expect(nextCursor(-1, 1, 0)).toBe(-1);
    });
});
