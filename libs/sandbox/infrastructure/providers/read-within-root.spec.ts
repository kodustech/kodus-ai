import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    isLineNumber,
    readWithinRootCommand,
    sedLineRange,
} from './read-within-root';

/**
 * The E2B read runs this command in the sandbox's shell. Here it runs in a
 * real one over a checkout that commits symlinks.
 */
describe('readWithinRootCommand', () => {
    let base: string;
    let repo: string;

    const read = (rel: string, start = 0, end = 0) => {
        try {
            return {
                out: execFileSync(
                    'sh',
                    [
                        '-c',
                        readWithinRootCommand(
                            path.join(repo, rel),
                            repo,
                            start,
                            end,
                        ),
                    ],
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
                ),
                failed: false,
            };
        } catch (err: any) {
            return { out: `${err.stdout}${err.stderr}`, failed: true };
        }
    };

    beforeAll(() => {
        base = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-read-root-')),
        );
        repo = path.join(base, 'repo');
        fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'outside.txt'), 'OUTSIDE_VALUE\n');
        fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one\ntwo\nthree\n');
        fs.writeFileSync(path.join(repo, "it's.ts"), 'quoted\n');
        fs.symlinkSync(
            path.join(base, 'outside.txt'),
            path.join(repo, 'notes.txt'),
        );
        fs.symlinkSync('src/a.ts', path.join(repo, 'inside-link.ts'));
        fs.symlinkSync(base, path.join(repo, 'up'));
    });

    afterAll(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('reads a file of the checkout, whole or by range', () => {
        expect(read('src/a.ts')).toEqual({
            out: 'one\ntwo\nthree\n',
            failed: false,
        });
        expect(read('src/a.ts', 2, 3).out).toBe('two\nthree\n');
        expect(read("it's.ts").out).toBe('quoted\n');
    });

    it('reads from the first line when only the end of the range is given', () => {
        expect(read('src/a.ts', 0, 2)).toEqual({
            out: 'one\ntwo\n',
            failed: false,
        });
    });

    it('refuses a symlink to a file outside the checkout', () => {
        const res = read('notes.txt');
        expect(res.failed).toBe(true);
        expect(res.out).toContain('Symlink detected');
        expect(res.out).not.toContain('OUTSIDE_VALUE');
    });

    it('refuses a symlink even when it points inside the checkout', () => {
        expect(read('inside-link.ts').failed).toBe(true);
    });

    // A root that is itself a symlink would move the boundary to wherever it
    // points: the root must already be its own real path.
    it('refuses a root that is a symlink', () => {
        const linkedRoot = path.join(base, 'linked-root');
        fs.symlinkSync(base, linkedRoot);
        let out = '';
        let failed = false;
        try {
            out = execFileSync(
                'sh',
                [
                    '-c',
                    readWithinRootCommand(
                        path.join(linkedRoot, 'outside.txt'),
                        linkedRoot,
                        0,
                        0,
                    ),
                ],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
            );
        } catch (err: any) {
            out = `${err.stdout}${err.stderr}`;
            failed = true;
        } finally {
            fs.unlinkSync(linkedRoot);
        }
        expect(failed).toBe(true);
        expect(out).toContain('Not a real directory');
        expect(out).not.toContain('OUTSIDE_VALUE');
    });

    it('refuses a path that leaves the checkout through a symlinked folder', () => {
        const res = read('up/outside.txt');
        expect(res.failed).toBe(true);
        expect(res.out).toContain('Path escapes repo boundary');
        expect(res.out).not.toContain('OUTSIDE_VALUE');
    });
});

describe('sedLineRange', () => {
    it('starts at line 1 when the range starts at 0, which GNU sed rejects', () => {
        expect(sedLineRange(0, 5)).toBe('1,5p');
        expect(sedLineRange(1, 5)).toBe('1,5p');
        expect(sedLineRange(7, 9)).toBe('7,9p');
    });

    it('refuses anything that is not a line number', () => {
        for (const [start, end] of [
            [-1, 5],
            [1.5, 5],
            [1, Number.NaN],
            ['1w /tmp/x', 5],
            [1, '5e id'],
        ] as unknown as [number, number][]) {
            expect(() => sedLineRange(start, end)).toThrow(
                /Invalid line range/,
            );
        }
    });
});

describe('isLineNumber', () => {
    it('accepts 0 and positive integers only', () => {
        expect(isLineNumber(0)).toBe(true);
        expect(isLineNumber(12)).toBe(true);
        expect(isLineNumber(-1)).toBe(false);
        expect(isLineNumber(2.5)).toBe(false);
        expect(isLineNumber('3')).toBe(false);
        expect(isLineNumber(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    });
});
