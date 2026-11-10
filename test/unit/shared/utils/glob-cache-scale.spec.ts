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
    _clearMatcherCache,
    _getMatcherCacheSize,
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
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
        isFileMatchingGlob('assets/logo.PNG', ['**/*.png']);
        isFileMatchingGlobCaseInsensitive('assets/logo.PNG', ['**/*.png']);

        expect(isFileMatchingGlob('assets/logo.PNG', ['**/*.png'])).toBe(false);
        expect(
            isFileMatchingGlobCaseInsensitive('assets/logo.PNG', ['**/*.png']),
        ).toBe(true);
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
        for (const pattern of patterns) {
            isFileMatchingGlob('src/app.ts', [pattern]);
        }

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
        for (const pattern of patterns) {
            isFileMatchingGlob('src/app.ts', [pattern]);
        }
        compileSpy.mockClear();

        // Most recent pattern is still cached: no recompilation.
        isFileMatchingGlob('src/app.ts', [patterns[patterns.length - 1]]);
        expect(compileSpy).not.toHaveBeenCalled();

        // The very first one was evicted: compiled again.
        isFileMatchingGlob('src/app.ts', [patterns[0]]);
        expect(compileSpy).toHaveBeenCalledTimes(1);
    });

    it('still returns correct results after evictions', () => {
        for (let i = 0; i < 6_000; i++) {
            isFileMatchingGlob('src/app.ts', [`**/noise-${i}/**`]);
        }
        expect(isFileMatchingGlob('dist/a.js', ['dist/**'])).toBe(true);
        expect(isFileMatchingGlob('src/a.js', ['dist/**'])).toBe(false);
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
