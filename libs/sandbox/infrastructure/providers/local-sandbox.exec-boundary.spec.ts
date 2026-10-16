import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
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
    });
});
