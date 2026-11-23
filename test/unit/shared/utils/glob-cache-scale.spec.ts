/**
 * glob-utils at the scale of the default ignore list.
 *
 * Every team's `ignorePaths` carries the ~1,100-pattern default list. With
 * the old 500-entry clear-all cache, walking that list wiped the cache on
 * every file and recompiled every pattern for every file, which blocked the
 * worker event loop for ~30s on a 970-file PR. These tests pin:
 *   1. results identical to an uncached reference implementation;
 *   2. each pattern compiled once, however many files are matched;
 *   3. the cache stays bounded and is not wiped when it fills;
 *   4. an invalid pattern throws in exactly the cases it threw before.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

jest.mock('picomatch', () => {
    const actual = jest.requireActual('picomatch');
    const spy = jest.fn((...args: unknown[]) => actual(...args));
    Object.assign(spy, actual);
    return spy;
});

import picomatch from 'picomatch';

import {
    _getCompiledListStats,
    _clearMatcherCache,
    _getMatcherCacheSize,
    createGlobMatcher,
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
    requiredLiteral,
} from '@libs/common/utils/glob-utils';

const actualPicomatch = jest.requireActual('picomatch');
const compileSpy = picomatch as unknown as jest.Mock;

const DEFAULT_IGNORE_PATHS: string[] = (
    yaml.load(
        fs.readFileSync(
            path.join(__dirname, '../../../../default-kodus-config.yml'),
            'utf8',
        ),
    ) as { ignorePaths: string[] }
).ignorePaths;

/** The matching rule glob-utils implements, with no cache at all. */
function referenceMatch(
    filename: string,
    patterns: string[],
    caseInsensitive: boolean,
): boolean {
    if (!patterns || patterns.length === 0) {
        return false;
    }
    const normalized = (filename || '')
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '');
    for (const pattern of patterns) {
        const matcher = actualPicomatch(pattern, {
            dot: true,
            nocase: caseInsensitive,
        });
        if (matcher(normalized)) {
            return true;
        }
    }
    return false;
}

/**
 * A path that holds `literal` (so the prefilter runs the matcher) but
 * matches no `**\/<literal>/**` pattern: the segment is `<literal>x`.
 */
function candidate(literal: string): string {
    return `src/${literal}x/app.ts`;
}

/** Paths that hit and miss the default list, in several path shapes. */
function samplePaths(): string[] {
    const paths = [
        'yarn.lock',
        'package.json',
        'apps/web/package.json',
        '.env',
        'config/settings.json',
        'assets/logo.PNG',
        'assets/logo.png',
        'media/intro.mp4',
        'dist/bundle.js',
        'build/output/app.js',
        'node_modules/react/index.js',
        '.idea/workspace.xml',
        '.vscode/settings.json',
        'src/prod/config.ts',
        'Dockerfile',
        'README.md',
        '/src/app.ts',
        './src/app.ts',
        'src\\windows\\path.ts',
        'docs/Guide.PDF',
        'vendor/lib.min.js',
        'coverage/lcov.info',
        '.cursor/rules/a.mdc',
        'Cargo.lock',
        'go.sum',
        'poetry.lock',
    ];
    const extensions = ['ts', 'tsx', 'go', 'py', 'rb', 'java', 'kt', 'rs'];
    for (let i = 0; i < 300; i++) {
        const ext = extensions[i % extensions.length];
        paths.push(`services/svc${i % 17}/internal/pkg${i}/file_${i}.${ext}`);
    }
    return paths;
}

describe('glob-utils with the default ignore list', () => {
    beforeEach(() => {
        _clearMatcherCache();
        compileSpy.mockClear();
    });

    it('loads the full default list (guards the fixture itself)', () => {
        expect(DEFAULT_IGNORE_PATHS.length).toBeGreaterThan(1_000);
    });

    it('returns exactly what the uncached reference returns (case-sensitive)', () => {
        const mismatches = samplePaths().filter(
            (file) =>
                isFileMatchingGlob(file, DEFAULT_IGNORE_PATHS) !==
                referenceMatch(file, DEFAULT_IGNORE_PATHS, false),
        );
        expect(mismatches).toEqual([]);
    });

    it('returns exactly what the uncached reference returns (case-insensitive)', () => {
        const mismatches = samplePaths().filter(
            (file) =>
                isFileMatchingGlobCaseInsensitive(
                    file,
                    DEFAULT_IGNORE_PATHS,
                ) !== referenceMatch(file, DEFAULT_IGNORE_PATHS, true),
        );
        expect(mismatches).toEqual([]);
    });

    it('keeps matching both ways (sanity: the sample has hits and misses)', () => {
        const results = samplePaths().map((file) =>
            isFileMatchingGlob(file, DEFAULT_IGNORE_PATHS),
        );
        expect(results).toContain(true);
        expect(results).toContain(false);
    });

    it('compiles each pattern once across many files and passes', () => {
        const files = samplePaths();
        // Two passes, like FetchChangedFilesStage (filtered + ignored lists).
        for (let pass = 0; pass < 2; pass++) {
            for (const file of files) {
                isFileMatchingGlob(file, DEFAULT_IGNORE_PATHS);
            }
        }

        const distinctPatterns = new Set(DEFAULT_IGNORE_PATHS).size;
        // Old behaviour: the cache wiped itself mid-list, so this was
        // roughly files × patterns × passes (hundreds of thousands).
        expect(compileSpy.mock.calls.length).toBeLessThanOrEqual(
            distinctPatterns,
        );
        expect(_getMatcherCacheSize().caseSensitive).toBeLessThanOrEqual(
            distinctPatterns,
        );
    });

    it('caches case-sensitive and case-insensitive matchers separately', () => {
        // `.png.PNG` holds the literal both ways, so both matchers compile.
        const file = 'assets/logo.png.PNG';
        isFileMatchingGlob(file, ['**/*.png']);
        isFileMatchingGlobCaseInsensitive(file, ['**/*.png']);

        expect(isFileMatchingGlob(file, ['**/*.png'])).toBe(false);
        expect(isFileMatchingGlobCaseInsensitive(file, ['**/*.png'])).toBe(
            true,
        );
        expect(_getMatcherCacheSize()).toEqual({
            caseSensitive: 1,
            caseInsensitive: 1,
        });
    });
});

describe('glob-utils cache bound', () => {
    beforeEach(() => {
        _clearMatcherCache();
        compileSpy.mockClear();
    });

    it('stays bounded and is not wiped when it fills', () => {
        const patterns = Array.from(
            { length: 6_000 },
            (_, i) => `**/generated-${i}/**`,
        );
        patterns.forEach((pattern, i) => {
            isFileMatchingGlob(candidate(`generated-${i}`), [pattern]);
        });

        const size = _getMatcherCacheSize().caseSensitive;
        expect(size).toBeLessThanOrEqual(5_000);
        // Clear-all would have left only the patterns since the last wipe.
        expect(size).toBeGreaterThan(4_000);
    });

    it('evicts the oldest patterns first and keeps the recent ones', () => {
        const patterns = Array.from(
            { length: 5_001 },
            (_, i) => `**/gen-${i}/**`,
        );
        patterns.forEach((pattern, i) => {
            isFileMatchingGlob(candidate(`gen-${i}`), [pattern]);
        });
        // A new list of the same patterns reuses no compiled list, so only
        // the per-pattern matcher cache decides what is compiled again.
        compileSpy.mockClear();

        // Most recent pattern is still cached: no recompilation.
        isFileMatchingGlob(candidate(`gen-${patterns.length - 1}`), [
            patterns[patterns.length - 1],
            '**/also-new-list-1/**',
        ]);
        expect(
            compileSpy.mock.calls.filter(
                ([p]) => p === patterns[patterns.length - 1],
            ),
        ).toHaveLength(0);

        // The very first one was evicted: compiled again.
        isFileMatchingGlob(candidate('gen-0'), [
            patterns[0],
            '**/also-new-list-2/**',
        ]);
        expect(
            compileSpy.mock.calls.filter(([p]) => p === patterns[0]),
        ).toHaveLength(1);
    });

    it('still returns correct results after evictions', () => {
        for (let i = 0; i < 6_000; i++) {
            isFileMatchingGlob(candidate(`noise-${i}`), [`**/noise-${i}/**`]);
        }
        expect(isFileMatchingGlob('dist/a.js', ['dist/**'])).toBe(true);
        expect(isFileMatchingGlob('src/a.js', ['dist/**'])).toBe(false);
    });

    it('keeps patterns in use through churn from one-off patterns (second chance)', () => {
        // The shared default list is hit on every file; tenant- or rule-
        // specific globs arrive once. Past the bound, eviction must drop the
        // one-off patterns, not the list in use.
        const hot = DEFAULT_IGNORE_PATHS.slice(0, 50);
        // Holds every hot pattern's literal, so each hot matcher compiles.
        const hotPath = candidate(hot.map(requiredLiteral).join('_'));
        for (let i = 0; i < 6_000; i++) {
            isFileMatchingGlob(candidate(`one-off-${i}`), [
                `**/one-off-${i}/**`,
            ]);
            if (i % 100 === 0) {
                isFileMatchingGlob(hotPath, hot);
            }
        }

        const compilesOfHot = compileSpy.mock.calls.filter(([pattern]) =>
            hot.includes(pattern as string),
        ).length;
        expect(compilesOfHot).toBe(new Set(hot).size);
    });
});

describe('glob-utils invalid patterns (unchanged semantics)', () => {
    beforeEach(() => {
        _clearMatcherCache();
    });

    const throws = (fn: () => unknown): boolean => {
        try {
            fn();
            return false;
        } catch {
            return true;
        }
    };

    it.each([
        [
            'matches before reaching the invalid pattern',
            'dist/a.js',
            ['dist/**', ''],
        ],
        ['reaches the invalid pattern', 'src/a.ts', ['dist/**', '']],
        ['invalid pattern first', 'dist/a.js', ['', 'dist/**']],
    ])(
        'throws exactly when the reference does: %s',
        (_label, file, patterns) => {
            expect(throws(() => isFileMatchingGlob(file, patterns))).toBe(
                throws(() => referenceMatch(file, patterns, false)),
            );
        },
    );
});

describe('glob-utils literal prefilter (2026-11-23 stall)', () => {
    beforeEach(() => {
        _clearMatcherCache();
    });

    /**
     * Near-misses of every default pattern: the pattern's own text with
     * wildcards filled in, nested, dotted, suffixed, with a trailing slash,
     * upper- and lower-cased. These are the shapes where a prefilter could
     * disagree with picomatch (`**\/tmp/**` matching `tmp`, a trailing `/`).
     */
    function nearMisses(): string[] {
        const out: string[] = [];
        for (const pattern of DEFAULT_IGNORE_PATHS) {
            const core = pattern
                .replace(/^\*\*\//, '')
                .replace(/\/\*\*$/, '')
                .replace(/^\*/, '')
                .replace(/\*/g, 'x')
                .replace(/\?/g, 'y')
                .replace(/\[([^\]]*)\]/g, (_, g: string) => g[0])
                .replace(/\{([^}]*)\}/g, (_, g: string) => g.split(',')[0]);
            out.push(
                core,
                `a/${core}`,
                `.${core}`,
                `${core}/`,
                `a/${core}/b`,
                `${core}x`,
                `x${core}`,
                `${core}.y`,
                core.toUpperCase(),
                core.toLowerCase(),
                `a/${core}/b/c.d`,
                core.replace(/^\./, ''),
            );
        }
        return out.concat([
            '.',
            '..',
            'a//b',
            'x.tar.gz',
            'a/.png',
            '.png',
            'tmp',
            'çã/ü.PNG',
        ]);
    }

    it.each([false, true])(
        'agrees with the reference on near-misses of every default pattern (caseInsensitive=%s)',
        (caseInsensitive) => {
            const match = caseInsensitive
                ? isFileMatchingGlobCaseInsensitive
                : isFileMatchingGlob;
            const files = nearMisses();
            const mismatches = files.filter(
                (file) =>
                    match(file, DEFAULT_IGNORE_PATHS) !==
                    referenceMatch(file, DEFAULT_IGNORE_PATHS, caseInsensitive),
            );
            expect(mismatches).toEqual([]);
            // The corpus exercises both outcomes.
            expect(files.some((f) => match(f, DEFAULT_IGNORE_PATHS))).toBe(
                true,
            );
            expect(files.some((f) => !match(f, DEFAULT_IGNORE_PATHS))).toBe(
                true,
            );
        },
    );

    it.each([
        ['**/*.png', '.png'],
        ['**/[Dd]ebug/**', 'ebug'],
        ['**/*.{js,ts}', '.'],
        ['**/node_modules/**', 'node_modules'],
        ['src/**/*.spec.ts', '.spec.ts'],
        ['!dist/**', ''],
        ['**/@(a|b).js', ''],
        ['**/(foo|bar).js', ''],
        // Nested brace groups: no alternative may survive as required.
        ['{a,{b}c}', ''],
        ['**/{dist,{build,out}.map}', ''],
        ['src/{a,{b,c}}/x.ts', 'x.ts'],
        ['**/*', ''],
    ])('requires the literal of %s to be %j', (pattern, literal) => {
        expect(requiredLiteral(pattern)).toBe(literal);
    });

    it.each([
        ['dist/a.js', ['**/{dist,{build,out}.map}/**']],
        ['build.map/a.js', ['**/{dist,{build,out}.map}/**']],
        ['a', ['{a,{b}c}']],
        // A `}` that does not close the group: escaped, or inside [...].
        ['a}c', ['{a\\},b}c']],
        ['cd', ['{a[}]b,c}d']],
    ])(
        'matches %s against nested brace groups as picomatch does',
        (file, patterns) => {
            expect(isFileMatchingGlob(file, patterns)).toBe(
                referenceMatch(file, patterns, false),
            );
            expect(isFileMatchingGlob(file, patterns)).toBe(true);
        },
    );

    it('keeps cached lists from pinning matchers past the matcher cache bound', () => {
        // A cached list must not hold its matchers: once the matcher cache
        // evicts them, matching the cached list again compiles them again.
        // When lists pinned their matchers, nothing was recompiled and the
        // live matchers grew past the cache bound with every cached list.
        const warm = Array.from({ length: 10 }, (_, j) => `**/warm-${j}/**`);
        const warmPath = candidate(warm.map(requiredLiteral).join('_'));
        isFileMatchingGlob(warmPath, warm);

        // Patterns with no required literal always compile: 6,000 of them
        // overflow the 5,000-entry matcher cache and evict the warm ones.
        const churn = Array.from(
            { length: 6_000 },
            (_, i) => `**/@(churn${i})/**`,
        );
        isFileMatchingGlob('src/app.ts', churn);

        compileSpy.mockClear();
        isFileMatchingGlob(warmPath, warm);
        const recompiled = compileSpy.mock.calls.filter(([pattern]) =>
            warm.includes(pattern as string),
        ).length;
        expect(recompiled).toBe(warm.length);
        expect(_getMatcherCacheSize().caseSensitive).toBeLessThanOrEqual(5_000);
    });

    it('skips the matcher of a pattern whose literal is not in the path', () => {
        compileSpy.mockClear();
        isFileMatchingGlob('src/app.ts', ['**/*.png', '**/node_modules/**']);
        expect(compileSpy).not.toHaveBeenCalled();
    });

    it('createGlobMatcher answers as isFileMatchingGlob does', () => {
        const files = samplePaths();
        const sensitive = createGlobMatcher(DEFAULT_IGNORE_PATHS);
        const insensitive = createGlobMatcher(DEFAULT_IGNORE_PATHS, {
            caseInsensitive: true,
        });
        for (const file of files) {
            expect(sensitive(file)).toBe(
                isFileMatchingGlob(file, DEFAULT_IGNORE_PATHS),
            );
            expect(insensitive(file)).toBe(
                isFileMatchingGlobCaseInsensitive(file, DEFAULT_IGNORE_PATHS),
            );
        }
        expect(createGlobMatcher([])('anything')).toBe(false);
    });

    it('createGlobMatcher keeps the list it was built with', () => {
        const patterns = ['**/*.png'];
        const matcher = createGlobMatcher(patterns);
        patterns.push('**/*.ts');
        expect(matcher('src/app.ts')).toBe(false);
        expect(matcher('logo.png')).toBe(true);
    });
});

describe('glob-utils prefilter and list cache (review of 2026-11-23)', () => {
    beforeEach(() => {
        _clearMatcherCache();
    });

    it.each([
        ['backslash escape', 'file\\d.txt', 'file1.txt'],
        ['leading ./', './*', 'Dockerfile'],
        ['./ hiding a negation', './!**/*.md', 'src/keep.ts'],
        ['] first in a class', '[]debug]', 'd'],
        ['escaped ] in a class', '[a\\]debug]', 'd'],
        ['POSIX class', '[[:alpha:]debug]', 'a'],
        ['double quotes', '**/"node_modules"/**', 'src/node_modules/a.js'],
    ])('matches as picomatch does: %s', (_label, pattern, file) => {
        for (const caseInsensitive of [false, true]) {
            _clearMatcherCache();
            const match = caseInsensitive
                ? isFileMatchingGlobCaseInsensitive
                : isFileMatchingGlob;
            expect(match(file, [pattern])).toBe(
                referenceMatch(file, [pattern], caseInsensitive),
            );
        }
    });

    it('never lets one cached list answer for a different list', () => {
        // Joined with NUL, these two lists shared a key.
        expect(isFileMatchingGlob('zz', ['a\u0000b'])).toBe(false);
        expect(isFileMatchingGlob('a', ['a', 'b'])).toBe(true);
        // Joined, [123] and ['123'] shared one too.
        expect(() =>
            isFileMatchingGlob('123', [123 as unknown as string]),
        ).toThrow();
        expect(isFileMatchingGlob('123', ['123'])).toBe(true);
    });

    it('does not cache a list larger than the whole budget', () => {
        isFileMatchingGlob('src/a.ts', ['**/warm/**']);
        const huge = Array.from({ length: 50_001 }, () => '**/huge/**');
        expect(isFileMatchingGlob('src/a.ts', huge)).toBe(false);
        expect(_getCompiledListStats()).toEqual({ lists: 1, patterns: 1 });
    });
});
