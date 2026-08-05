import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Regression coverage for running the CLI from a linked git worktree.
 *
 * Inside a worktree `.git` is a *file* pointing at
 * `<main>/.git/worktrees/<name>`, so anything that joins `.git/hooks` onto the
 * worktree root blows up with ENOTDIR. Git itself shares hooks across
 * worktrees, so the hook must land in the main checkout's hooks directory.
 */

let tmpDir: string;
let mainRepo: string;
let worktree: string;
let cliEntryPoint: string;

function run(
    args: string[],
    cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cliEntryPoint, ...args], {
            cwd,
            // Without this the CLI reaches the network on every invocation and
            // the test hangs when that call is slow.
            env: { ...process.env, KODUS_DISABLE_UPDATE_CHECK: '1' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', reject);
        child.on('close', (code) =>
            resolve({ code: code ?? 0, stdout, stderr }),
        );
    });
}

function git(args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'Test',
                GIT_AUTHOR_EMAIL: 'test@test.com',
                GIT_COMMITTER_NAME: 'Test',
                GIT_COMMITTER_EMAIL: 'test@test.com',
            },
        });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`git ${args.join(' ')} failed (${code})`)),
        );
    });
}

describe('Worktree E2E — hook commands', { timeout: 60_000 }, () => {
    beforeAll(async () => {
        const cliRoot = path.resolve(
            import.meta.dirname ??
                path.dirname(new URL(import.meta.url).pathname),
            '..',
            '..',
        );
        cliEntryPoint = path.join(cliRoot, 'dist', 'index.js');
        await fs.access(cliEntryPoint);

        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-worktree-'));
        mainRepo = path.join(tmpDir, 'main');
        worktree = path.join(tmpDir, 'wt');

        await fs.mkdir(mainRepo, { recursive: true });
        await git(['init', '--initial-branch=main'], mainRepo);
        await git(['commit', '--allow-empty', '-m', 'initial'], mainRepo);
        await git(['worktree', 'add', worktree, '-b', 'feature'], mainRepo);
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('installs the pre-push hook into the shared hooks dir', async () => {
        const result = await run(['hook', 'install', '--force'], worktree);

        expect(result.stderr).not.toContain('ENOTDIR');
        expect(result.code).toBe(0);

        // Git executes hooks from the main checkout for every linked worktree.
        const hookPath = path.join(mainRepo, '.git', 'hooks', 'pre-push');
        const content = await fs.readFile(hookPath, 'utf-8');
        expect(content).toContain('# kodus-hook');

        // And nothing may have been written under the worktree's `.git` file.
        const dotGit = await fs.stat(path.join(worktree, '.git'));
        expect(dotGit.isFile()).toBe(true);
    });

    it('reports the hook as installed from inside the worktree', async () => {
        const result = await run(['hook', 'status'], worktree);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('installed');
        expect(result.stdout).not.toContain('not installed');
    });

    it('resolves the hooks dir from a nested subdirectory', async () => {
        // `--git-common-dir` is cwd-relative in an ordinary checkout, so a
        // fallback that resolved it against the toplevel would climb above the
        // repo and report the hook as missing.
        const nested = path.join(worktree, 'deep', 'nested');
        await fs.mkdir(nested, { recursive: true });

        const result = await run(['hook', 'status'], nested);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('installed');
        expect(result.stdout).not.toContain('not installed');
    });

    it('uninstalls the hook from inside the worktree', async () => {
        const result = await run(['hook', 'uninstall'], worktree);
        expect(result.code).toBe(0);

        const hookPath = path.join(mainRepo, '.git', 'hooks', 'pre-push');
        await expect(fs.access(hookPath)).rejects.toThrow();
    });
});
