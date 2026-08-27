import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';

import { findIgnoreMatch } from '../../../apps/web/src/core/utils/ignore-paths/match-file-against-ignore-paths';

// The web validator can't import the backend matcher (see the header comment in
// match-file-against-ignore-paths.ts), so it re-implements it against minimatch
// instead of picomatch. This spec is what keeps the two from drifting: the
// validator lying about whether a file gets reviewed is the exact failure the
// feature exists to prevent.
describe('findIgnoreMatch', () => {
    const PATTERNS = [
        'yarn.lock',
        '**/*.json',
        '**/dist/**',
        '**/.idea/**',
        '**/*.png',
        '**/[Bb]uild/**',
        '**/*.min.*',
    ];

    it('names the pattern that ignores the file', () => {
        expect(findIgnoreMatch('app/dist/main.js', PATTERNS)).toBe('**/dist/**');
        expect(findIgnoreMatch('yarn.lock', PATTERNS)).toBe('yarn.lock');
    });

    it('returns undefined when nothing matches', () => {
        expect(findIgnoreMatch('src/button.tsx', PATTERNS)).toBeUndefined();
    });

    it('reports the first match when several patterns apply', () => {
        expect(findIgnoreMatch('a/dist/b.json', PATTERNS)).toBe('**/*.json');
    });

    it('normalizes the path the way the backend does', () => {
        for (const spelling of [
            'app/dist/main.js',
            './app/dist/main.js',
            '/app/dist/main.js',
            'app\\dist\\main.js',
        ]) {
            expect(findIgnoreMatch(spelling, PATTERNS)).toBe('**/dist/**');
        }
    });

    it('treats an empty filename as not ignored', () => {
        expect(findIgnoreMatch('', PATTERNS)).toBeUndefined();
        expect(findIgnoreMatch('   ', PATTERNS)).toBeUndefined();
    });

    it('agrees with the backend matcher on every case', () => {
        const files = [
            'src/button.tsx',
            'yarn.lock',
            'package.json',
            'nested/deep/config.json',
            'app/dist/main.js',
            './app/dist/main.js',
            '/app/dist/main.js',
            'app\\dist\\main.js',
            '.idea/workspace.xml',
            'assets/logo.png',
            'Build/output.txt',
            'build/output.txt',
            'vendor/lib.min.js',
            'src/dist.ts',
            'distribution/main.js',
            'a/b/c/d/e/f.png',
            'README.md',
        ];

        for (const file of files) {
            expect([file, Boolean(findIgnoreMatch(file, PATTERNS))]).toEqual([
                file,
                isFileMatchingGlob(file, PATTERNS),
            ]);
        }
    });
});
