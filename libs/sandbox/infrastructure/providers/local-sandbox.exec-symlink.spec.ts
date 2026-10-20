import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalSandboxService } from './local-sandbox.service';

/**
 * Sandbox read boundary — the local sandbox `read` refuses symlinks and checks
 * the resolved path against the repo, but `exec` did neither: it validated
 * only the argument strings (`..`, absolute paths) and then ran a whitelisted
 * reader (`cat`, `head`, …) that follows symlinks. A symlink committed in a PR
 * therefore let `exec` read any file the worker can read, and `find`/`fd` —
 * both whitelisted — carry `-exec`/`-x` flags that run arbitrary programs on
 * the host (RCE), far past the file-disclosure the advisory described.
 *
 * These are the regression guards for both holes.
 */
describe('LocalSandboxService exec — symlink escape', () => {
    let repo: string;
    let outside: string;
    let rc: any;

    beforeAll(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-exec-symlink-repo-'));
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-exec-symlink-out-'));
        fs.writeFileSync(path.join(outside, 'secret.env'), 'DB_PASSWORD=hunter2\n');
        fs.writeFileSync(path.join(repo, 'real.txt'), 'in-repo content\n');

        // A symlink committed in the repo pointing at a file outside it.
        fs.symlinkSync(
            path.join(outside, 'secret.env'),
            path.join(repo, 'notes.txt'),
        );
        // A symlinked directory pointing outside the repo.
        fs.symlinkSync(outside, path.join(repo, 'linkdir'));

        rc = (new LocalSandboxService({} as any) as any).buildRemoteCommands(repo);
    });

    afterAll(() => {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    const expectRefused = async (cmd: string) => {
        const r = await rc.exec(cmd);
        expect(r.exitCode).not.toBe(0);
        expect(r.stdout).not.toMatch(/hunter2/);
        expect(r.stderr).not.toMatch(/hunter2/);
    };

    it('refuses to cat a symlink that points outside the repo', async () => {
        await expectRefused('cat notes.txt');
    });

    it('refuses to head a symlink that points outside the repo', async () => {
        await expectRefused('head notes.txt');
    });

    it('refuses to read a file reached through a symlinked directory', async () => {
        await expectRefused('cat linkdir/secret.env');
    });

    it('refuses find -L (follow symlinks) escaping the repo', async () => {
        const r = await rc.exec('find -L . -name secret.env');
        expect(r.stdout).not.toMatch(/secret\.env/);
    });

    it('still reads a normal in-repo file', async () => {
        const r = await rc.exec('cat real.txt');
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/in-repo content/);
    });

    it('still greps in-repo content', async () => {
        const r = await rc.exec('grep -n content real.txt');
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/in-repo content/);
    });
});

/**
 * The whitelist admits `find` and `fd` as read-only file finders, but both
 * accept flags that execute arbitrary programs (`find -exec`, `fd -x`) or
 * delete/write files. A whitelisted finder must not become a command runner.
 */
describe('LocalSandboxService exec — blocks executor flags', () => {
    let repo: string;
    let rc: any;

    beforeAll(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-exec-flags-repo-'));
        fs.writeFileSync(path.join(repo, 'real.txt'), 'ok\n');
        rc = (new LocalSandboxService({} as any) as any).buildRemoteCommands(repo);
    });

    afterAll(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    const expectBlocked = async (cmd: string) => {
        const r = await rc.exec(cmd);
        expect(r.exitCode).toBe(1);
        // The marker a successful exec of the injected program would print
        // must never appear.
        expect(r.stdout).not.toMatch(/PWNED/);
    };

    it('blocks find -exec', async () => {
        await expectBlocked(
            "find . -maxdepth 0 -exec sh -c 'echo PWNED' {} +",
        );
    });

    it('blocks find -execdir', async () => {
        await expectBlocked(
            "find . -maxdepth 0 -execdir sh -c 'echo PWNED' {} +",
        );
    });

    it('blocks find -delete', async () => {
        await expectBlocked('find . -name real.txt -delete');
        expect(fs.existsSync(path.join(repo, 'real.txt'))).toBe(true);
    });

    it('blocks find -fprint', async () => {
        await expectBlocked('find . -maxdepth 0 -fprint out.txt');
    });

    it('blocks fd --exec', async () => {
        await expectBlocked("fd . --exec sh -c 'echo PWNED'");
    });

    it('blocks fd -x', async () => {
        await expectBlocked("fd -x sh -c 'echo PWNED' . real.txt");
    });

    it('blocks fd --exec=sh (clap joined form)', async () => {
        await expectBlocked("fd . --exec=sh -c 'echo PWNED'");
    });

    it('blocks fd --exec-batch=sh (clap joined form)', async () => {
        await expectBlocked("fd . --exec-batch=sh -c 'echo PWNED'");
    });

    it('still allows a plain find over the repo', async () => {
        const r = await rc.exec('find . -name real.txt');
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/real\.txt/);
    });

    it('still allows grep -x (whole-line match, not an executor)', async () => {
        const r = await rc.exec('grep -x ok real.txt');
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/ok/);
    });
});
