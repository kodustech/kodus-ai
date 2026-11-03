import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readWithinRootCommand } from './read-within-root';

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

    it('refuses a symlink to a file outside the checkout', () => {
        const res = read('notes.txt');
        expect(res.failed).toBe(true);
        expect(res.out).toContain('Symlink detected');
        expect(res.out).not.toContain('OUTSIDE_VALUE');
    });

    it('refuses a symlink even when it points inside the checkout', () => {
        expect(read('inside-link.ts').failed).toBe(true);
    });

    it('refuses a path that leaves the checkout through a symlinked folder', () => {
        const res = read('up/outside.txt');
        expect(res.failed).toBe(true);
        expect(res.out).toContain('Path escapes repo boundary');
        expect(res.out).not.toContain('OUTSIDE_VALUE');
    });
});
