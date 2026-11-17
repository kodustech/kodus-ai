/**
 * REGRESSION TESTS - glob-utils
 *
 * These tests capture the CURRENT behavior of isFileMatchingGlob.
 * When implementing the matcher cache optimization, these tests ensure
 * behavior remains identical.
 *
 * CRITICAL: Do NOT modify existing tests when implementing cache.
 */

import {
    isFileMatchingGlob,
    isFileMatchingGlobCaseInsensitive,
} from '@/shared/utils/glob-utils';

describe('globMatch', () => {
    it('matches .cursor/rules/**/*.mdc against rule files in tree', () => {
        const pattern = '.cursor/rules/**/*.mdc';
        expect(
            isFileMatchingGlob('.cursor/rules/accessibility.mdc', [pattern]),
        ).toBe(true);
        expect(
            isFileMatchingGlob('.cursor/rules/animation.mdc', [pattern]),
        ).toBe(true);
        expect(isFileMatchingGlob('.cursor/rules/assets.mdc', [pattern])).toBe(
            true,
        );
        expect(isFileMatchingGlob('.gitignore', [pattern])).toBe(false);
    });

    it('matches when provider returns a leading slash', () => {
        const pattern = '.cursor/rules/**/*.mdc';
        expect(
            isFileMatchingGlob('/.cursor/rules/accessibility.mdc', [pattern]),
        ).toBe(true);
        expect(
            isFileMatchingGlob('/.cursor/rules/sub/dir/file.mdc', [pattern]),
        ).toBe(true);
    });

    it('matches nested folders with **', () => {
        const pattern = '.cursor/rules/**/*.mdc';
        expect(
            isFileMatchingGlob('.cursor/rules/sub/dir/file.mdc', [pattern]),
        ).toBe(true);
        expect(
            isFileMatchingGlob('.cursor/rules/subdir/file.txt', [pattern]),
        ).toBe(false);
    });

    it('matches exact files and directories', () => {
        expect(isFileMatchingGlob('.cursorrules', ['.cursorrules'])).toBe(true);
        expect(isFileMatchingGlob('CLAUDE.md', ['CLAUDE.md'])).toBe(true);
        expect(
            isFileMatchingGlob('docs/coding-standards/guide.md', [
                'docs/coding-standards/**/*',
            ]),
        ).toBe(true);
    });

    it('does not let single * cross directory boundaries', () => {
        expect(isFileMatchingGlob('docs/a.md', ['docs/*'])).toBe(true);
        expect(isFileMatchingGlob('docs/a/b.md', ['docs/*'])).toBe(false);
    });

    it('supports character class and ? wildcard', () => {
        expect(isFileMatchingGlob('file-a.md', ['file-[ab].md'])).toBe(true);
        expect(isFileMatchingGlob('file-b.md', ['file-[ab].md'])).toBe(true);
        expect(isFileMatchingGlob('file-c.md', ['file-[ab].md'])).toBe(false);
        expect(isFileMatchingGlob('a.md', ['?.md'])).toBe(true);
        expect(isFileMatchingGlob('ab.md', ['?.md'])).toBe(false);
    });

    it('supports brace expansion for extensions', () => {
        expect(isFileMatchingGlob('src/app.ts', ['src/**/*.{ts,js}'])).toBe(
            true,
        );
        expect(isFileMatchingGlob('src/app.js', ['src/**/*.{ts,js}'])).toBe(
            true,
        );
        expect(isFileMatchingGlob('src/app.jsx', ['src/**/*.{ts,js}'])).toBe(
            false,
        );
    });

    it('matches dotfiles when pattern includes a dotfile', () => {
        expect(isFileMatchingGlob('.aiderignore', ['.aiderignore'])).toBe(true);
        expect(isFileMatchingGlob('.aider.conf.yml', ['.aider.conf.yml'])).toBe(
            true,
        );
        expect(
            isFileMatchingGlob('.github/copilot-instructions.md', [
                '.github/copilot-instructions.md',
            ]),
        ).toBe(true);
    });

    it('matches more repository rule patterns', () => {
        expect(
            isFileMatchingGlob('.sourcegraph/rules/one.rule.md', [
                '.sourcegraph/**/*.rule.md',
            ]),
        ).toBe(true);
        expect(
            isFileMatchingGlob('.rules/backend/security.md', ['.rules/**/*']),
        ).toBe(true);
        expect(isFileMatchingGlob('.kody/rules.json', ['.kody/**/*'])).toBe(
            true,
        );
        expect(isFileMatchingGlob('.windsurfrules', ['.windsurfrules'])).toBe(
            true,
        );
    });
});

// ============================================================================
// REGRESSION TESTS FOR CACHE OPTIMIZATION
// ============================================================================

describe('globMatch - REGRESSION: Cache optimization safety', () => {
    /**
     * These tests ensure that when we implement matcher caching,
     * the results remain identical to the current implementation.
     */

    describe('REGRESSION: Same pattern, multiple files', () => {
        /**
         * Key scenario: Same pattern used for many files.
         * Current: Pattern is recompiled for each file.
         * Optimized: Pattern is compiled once and cached.
         *
         * Results MUST be identical.
         */
        it('should return consistent results for same pattern across many files', () => {
            const patterns = ['**/*.ts', '**/*.spec.ts'];
            const files = [
                'src/index.ts',
                'src/app.ts',
                'src/utils/helper.ts',
                'src/utils/helper.spec.ts',
                'test/app.spec.ts',
                'package.json',
                'README.md',
                'src/styles/main.css',
            ];

            const results = files.map((file) => ({
                file,
                matches: isFileMatchingGlob(file, patterns),
            }));

            expect(results).toEqual([
                { file: 'src/index.ts', matches: true },
                { file: 'src/app.ts', matches: true },
                { file: 'src/utils/helper.ts', matches: true },
                { file: 'src/utils/helper.spec.ts', matches: true },
                { file: 'test/app.spec.ts', matches: true },
                { file: 'package.json', matches: false },
                { file: 'README.md', matches: false },
                { file: 'src/styles/main.css', matches: false },
            ]);
        });

        it('should handle ignore patterns consistently across many files', () => {
            // Common ignore patterns from .kodeignore files
            // Note: *.lock matches files ending in .lock (yarn.lock, pnpm-lock.yaml)
            // NOT package-lock.json which ends in .json
            const ignorePatterns = [
                'node_modules/**',
                '*.lock', // Matches yarn.lock, pnpm-lock.yaml, NOT package-lock.json
                '*-lock.json', // Matches package-lock.json
                'dist/**',
                '.git/**',
                '**/*.min.js',
                'coverage/**',
            ];

            const files = [
                'node_modules/lodash/index.js',
                'node_modules/react/package.json',
                'package-lock.json',
                'yarn.lock',
                'dist/bundle.js',
                'dist/index.html',
                '.git/HEAD',
                '.git/config',
                'src/vendor/lib.min.js',
                'assets/scripts/app.min.js',
                'coverage/lcov.info',
                'src/index.ts', // Should NOT match
                'README.md', // Should NOT match
            ];

            const results = files.map((file) => ({
                file,
                shouldIgnore: isFileMatchingGlob(file, ignorePatterns),
            }));

            expect(results).toEqual([
                { file: 'node_modules/lodash/index.js', shouldIgnore: true },
                { file: 'node_modules/react/package.json', shouldIgnore: true },
                { file: 'package-lock.json', shouldIgnore: true },
                { file: 'yarn.lock', shouldIgnore: true },
                { file: 'dist/bundle.js', shouldIgnore: true },
                { file: 'dist/index.html', shouldIgnore: true },
                { file: '.git/HEAD', shouldIgnore: true },
                { file: '.git/config', shouldIgnore: true },
                { file: 'src/vendor/lib.min.js', shouldIgnore: true },
                { file: 'assets/scripts/app.min.js', shouldIgnore: true },
                { file: 'coverage/lcov.info', shouldIgnore: true },
                { file: 'src/index.ts', shouldIgnore: false },
                { file: 'README.md', shouldIgnore: false },
            ]);
        });
    });

    describe('REGRESSION: Edge cases that cache must handle', () => {
        it('should handle empty patterns array', () => {
            expect(isFileMatchingGlob('any-file.ts', [])).toBe(false);
        });

        it('should handle empty filename', () => {
            expect(isFileMatchingGlob('', ['**/*.ts'])).toBe(false);
        });

        it('should handle patterns with special regex characters', () => {
            // These should be treated as glob patterns, not regex
            expect(isFileMatchingGlob('file.ts', ['file.ts'])).toBe(true);
            expect(isFileMatchingGlob('file+plus.ts', ['file+plus.ts'])).toBe(
                true,
            );
            expect(isFileMatchingGlob('file[0].ts', ['file[0].ts'])).toBe(true);
        });

        it('should handle multiple matching patterns (any match = true)', () => {
            const patterns = ['*.ts', '*.js', '*.tsx'];

            expect(isFileMatchingGlob('file.ts', patterns)).toBe(true);
            expect(isFileMatchingGlob('file.js', patterns)).toBe(true);
            expect(isFileMatchingGlob('file.tsx', patterns)).toBe(true);
            expect(isFileMatchingGlob('file.css', patterns)).toBe(false);
        });

        it('does not treat a "!" pattern as an exclusion (any match = true)', () => {
            const patterns = ['**/*.ts', '!**/*.spec.ts', '!**/*.test.ts'];

            expect(isFileMatchingGlob('src/index.ts', patterns)).toBe(true);
            expect(isFileMatchingGlob('src/app.spec.ts', patterns)).toBe(true);
        });
    });
});

// ============================================================================
// CASE INSENSITIVE REGRESSION TESTS
// ============================================================================

describe('globMatch - isFileMatchingGlobCaseInsensitive', () => {
    describe('REGRESSION: Case insensitive matching', () => {
        it('should match regardless of case', () => {
            const patterns = ['README.md', 'src/**/*.ts'];

            expect(
                isFileMatchingGlobCaseInsensitive('readme.md', patterns),
            ).toBe(true);
            expect(
                isFileMatchingGlobCaseInsensitive('README.MD', patterns),
            ).toBe(true);
            expect(
                isFileMatchingGlobCaseInsensitive('ReadMe.Md', patterns),
            ).toBe(true);
            expect(
                isFileMatchingGlobCaseInsensitive('SRC/App.TS', patterns),
            ).toBe(true);
            expect(
                isFileMatchingGlobCaseInsensitive(
                    'Src/Utils/Helper.Ts',
                    patterns,
                ),
            ).toBe(true);
        });
    });
});
