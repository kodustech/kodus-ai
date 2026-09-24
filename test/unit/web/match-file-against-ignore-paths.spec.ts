import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';

import { findIgnoreMatch } from '../../../apps/web/src/core/utils/ignore-paths/match-file-against-ignore-paths';

// The web can't import the backend matcher (see that module's header), so the
// logic is duplicated. This spec is what keeps the copies honest: the "Test a
// file" verdict claiming a file is ignored when the pipeline would review it
// is the exact failure the feature exists to prevent.
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

    // Files chosen to exercise the constructs the shipped list actually uses:
    // character classes, ranges, extglobs, literal parens and spaces, dotfiles,
    // and the `?`/`*` wildcards.
    const FILES = [
        'src/button.tsx',
        'README.md',
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
        'src/main.py',
        'a/b/c/d.pyc',
        'Thumbs.db',
        'x/node_modules/y/index.js',
        'test/version_tmp/a',
        'docs/api/index.html',
        'app/$RECYCLE.BIN/f',
        'Generated Files/a.cs',
        'my.heic',
        'clip.m4v',
        'win32/app.exe',
        'file.i686',
        'report.Q1',
        'a.__1',
        'TestResults/x.trx',
        'my- Backup (3).rdl',
        '._.swp',
        'x.ReSharper',
        '.dotcrunch.local.xml',
        'a/b/production',
        'deep/nested/path/to/some/file.ts',
    ];

    it('agrees with the backend matcher on every shipped default', () => {
        const patterns: string[] = (getDefaultKodusConfigFile() as any)
            .ignorePaths;

        expect(patterns.length).toBeGreaterThan(1000);

        const disagreements: string[] = [];

        for (const pattern of patterns) {
            for (const file of FILES) {
                const web = Boolean(findIgnoreMatch(file, [pattern]));
                const pipeline = isFileMatchingGlob(file, [pattern]);

                if (web !== pipeline) {
                    disagreements.push(
                        `${pattern} × ${file}: web=${web} pipeline=${pipeline}`,
                    );
                }
            }
        }

        expect(disagreements).toEqual([]);
    });

    it('agrees with the backend matcher on the full list at once', () => {
        const patterns: string[] = (getDefaultKodusConfigFile() as any)
            .ignorePaths;

        for (const file of FILES) {
            expect([file, Boolean(findIgnoreMatch(file, patterns))]).toEqual([
                file,
                isFileMatchingGlob(file, patterns),
            ]);
        }
    });
});
