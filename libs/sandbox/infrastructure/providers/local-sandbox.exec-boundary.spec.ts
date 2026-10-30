import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalSandboxService } from './local-sandbox.service';

/**
 * Exec boundary — the whitelisted finders must stay read-only inside the clone
 * even when the dangerous flag or the outside path is smuggled in a form the
 * naive checks miss: a glued/stacked short-flag cluster (`-xsh`, `-Lx`, `-Rn`)
 * and a hard link (which `realpath` does not resolve, unlike a symlink).
 */
describe('LocalSandboxService exec — flag/path boundary', () => {
    const svc = new LocalSandboxService({} as any);
    let repo: string;
    let outside: string;
    let exec: (c: string) => Promise<{ stdout: string; exitCode: number }>;

    const isBlocked = (r: { stdout: string; exitCode: number }) =>
        r.exitCode !== 0 &&
        /not allowed|resolves outside|hard link|path traversal/i.test(r.stdout);
    const leaks = (r: { stdout: string }) => /OUTSIDE_SECRET/.test(r.stdout);

    beforeAll(async () => {
        repo = await mkdtemp(join(tmpdir(), 'repo-'));
        outside = await mkdtemp(join(tmpdir(), 'outside-'));
        await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_SECRET\n');
        await writeFile(join(repo, 'a.txt'), 'bait line in-repo\n');
        await symlink(join(outside, 'secret.txt'), join(repo, 'slink'));
        // a committed symlink whose name starts with '-' (read via `cat -- -x`)
        await symlink(join(outside, 'secret.txt'), join(repo, '-dashlink'));
        // a symlinked DIRECTORY pointing outside — reached via a child path
        // (`cat linkdir/secret.txt`) that the per-arg realpath must still catch
        await symlink(outside, join(repo, 'linkdir'));
        // a chained symlink: nested -> slink -> outside
        await symlink(join(repo, 'slink'), join(repo, 'nested'));
        // a symlink living in a subdirectory
        await mkdir(join(repo, 'sub'));
        await symlink(join(outside, 'secret.txt'), join(repo, 'sub', 'slink2'));
        // hard link inside the repo to the outside file (same tmpfs)
        execFileSync('ln', [join(outside, 'secret.txt'), join(repo, 'hlink')]);
        exec = (svc as any).buildRemoteCommands(repo).exec;
    });

    describe('P1a — exec/follow flag in a short-flag cluster', () => {
        it.each([
            'grep -R bait .', // exact dangerous flag (control)
            'grep -Rn bait .', // stacked: -R hides in -Rn
            'fd -x sh', // exact (control)
            'fd -xsh', // glued: -x sh
            'fd -Lx sh', // stacked: -L and -x
        ])('blocks %s', async (cmd) => {
            expect(isBlocked(await exec(cmd))).toBe(true);
        });

        it.each([
            'grep -rn bait a.txt', // lowercase -r (no symlink follow) is allowed
            'grep -in bait a.txt', // -in cluster, no dangerous char
            'cat a.txt', // plain read
        ])('still allows the legitimate command %s', async (cmd) => {
            const r = await exec(cmd);
            expect(isBlocked(r)).toBe(false);
            expect(r.exitCode).toBe(0);
        });
    });

    describe('P1b — read outside the clone', () => {
        it('blocks a symlink that escapes the repo', async () => {
            const r = await exec('cat slink');
            expect(isBlocked(r)).toBe(true);
            expect(leaks(r)).toBe(false);
        });

        it('blocks a hard link that escapes the repo', async () => {
            const r = await exec('cat hlink');
            expect(isBlocked(r)).toBe(true);
            expect(leaks(r)).toBe(false);
        });

        it('blocks a dash-named symlink read past the options terminator', async () => {
            // `-dashlink` starts with '-', so a naive flag skip would never
            // realpath-check it; `cat -- -dashlink` then reads outside the clone.
            const r = await exec('cat -- -dashlink');
            expect(isBlocked(r)).toBe(true);
            expect(leaks(r)).toBe(false);
        });

        // The variants an independent reviewer reaches for next: the escape is
        // not the symlink's own name but a path that passes THROUGH one. The
        // per-arg realpath canonicalises the whole path, so each is caught.
        it.each([
            'cat nested', // chained symlink nested -> slink -> outside
            'cat sub/slink2', // symlink nested in a subdirectory
            'cat linkdir/secret.txt', // child of a symlinked directory
            'grep -rn SECRET linkdir', // recurse into a symlinked directory
            'find linkdir -type f', // enumerate a symlinked directory
            'cat a.txt slink', // a legit file mixed with the escape arg
        ])('blocks the outside read via %s', async (cmd) => {
            const r = await exec(cmd);
            expect(isBlocked(r)).toBe(true);
            expect(leaks(r)).toBe(false);
        });
    });

    // The per-arg realpath check only sees the paths passed as arguments. A
    // symlink-following flag makes the reader DISCOVER a symlinked directory
    // mid-walk (never an argument) and read its outside target. `linkdir`
    // points outside, so each of these would leak without the flag being
    // refused outright. `ast-grep/sg --follow` was the last traverser missing
    // the guard that find/fd/grep already had.
    describe('P1c — walk-time symlink follow', () => {
        it.each([
            "sg run --follow -p 'const secret = $V' -l js .",
            "ast-grep run --follow -p 'const secret = $V' -l js .",
            'find . -L', // find follow (control — already blocked)
            'fd --follow secret', // fd follow (control — already blocked)
            'grep -R SECRET .', // grep recurse-follow (control — already blocked)
        ])('refuses the follow flag in %s', async (cmd) => {
            const r = await exec(cmd);
            expect(isBlocked(r)).toBe(true);
            expect(leaks(r)).toBe(false);
        });
    });
});
