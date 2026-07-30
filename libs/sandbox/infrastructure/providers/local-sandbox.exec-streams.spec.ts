import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalSandboxService } from './local-sandbox.service';

/**
 * exec must return stdout and stderr SEPARATELY (plus a real exitCode) rather
 * than merging stderr into stdout. The merge is what let a subprocess error
 * ("fd: command not found", "No such file") masquerade as real command output
 * in the tools that consume exec.
 */
describe('LocalSandboxService exec — separates stdout and stderr', () => {
    let dir: string;
    let rc: any;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-exec-streams-'));
        fs.writeFileSync(path.join(dir, 'real.txt'), 'hello world\n');
        const svc = new LocalSandboxService({} as any);
        rc = (svc as any).buildRemoteCommands(dir);
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps a failing single command’s stderr out of stdout', async () => {
        const r = await rc.exec('cat nonexistent.txt');
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toMatch(/nonexistent/i);
        expect(r.stdout).not.toMatch(/nonexistent/i);
    });

    it('returns clean stdout with empty stderr on success', async () => {
        const r = await rc.exec('cat real.txt');
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/hello world/);
        expect(r.stderr ?? '').not.toMatch(/hello world/);
    });

    it('keeps stderr out of stdout in a pipeline', async () => {
        const r = await rc.exec('cat nonexistent.txt | head');
        expect(r.stderr).toMatch(/nonexistent/i);
        expect(r.stdout).not.toMatch(/nonexistent/i);
    });
});

/**
 * Command-argument path-traversal guard. Absolute paths and `..` segments must
 * be rejected regardless of separator so the guard holds on Windows hosts too
 * (backslash args like `..\etc` / `C:\x`), not only POSIX. Regression guard for
 * the `isAbsolute` + `[/\\]` hardening of `hasTraversal`.
 */
describe('LocalSandboxService exec — rejects path traversal in args', () => {
    let dir: string;
    let rc: any;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-exec-traversal-'));
        fs.writeFileSync(path.join(dir, 'real.txt'), 'hello\n');
        const svc = new LocalSandboxService({} as any);
        rc = (svc as any).buildRemoteCommands(dir);
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const expectBlocked = async (cmd: string) => {
        const r = await rc.exec(cmd);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toMatch(/path traversal/i);
    };

    it('blocks a POSIX absolute path arg', async () => {
        await expectBlocked('cat /etc/passwd');
    });

    it('blocks a POSIX .. traversal arg (even after a valueless flag)', async () => {
        // The comment on hasTraversal calls out `cat -n ../../../etc/passwd`
        // specifically — a valueless flag before a malicious path.
        await expectBlocked('cat -n ../../../etc/passwd');
    });

    it('blocks a backslash .. traversal arg (Windows-style)', async () => {
        await expectBlocked('cat ..\\..\\secret.txt');
    });

    it('still allows a clean repo-relative arg', async () => {
        const r = await rc.exec('cat real.txt');
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/hello/);
    });
});
