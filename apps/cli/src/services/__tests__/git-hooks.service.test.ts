import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { gitHooksService, TRACE_HOOK_MARKER } from '../git-hooks.service.js';

let tmpDir: string;
let hooksDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-git-hooks-'));
    hooksDir = path.join(tmpDir, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function hookPath(name: string): string {
    return path.join(hooksDir, name);
}

async function executePrePush(input: string): Promise<string[]> {
    await gitHooksService.install(hooksDir);

    const fakeBin = path.join(tmpDir, 'bin');
    const capturePath = path.join(tmpDir, 'distill-args.log');
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(
        path.join(fakeBin, 'kodus'),
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$KODUS_CAPTURE"\n',
        { mode: 0o755 },
    );

    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            hookPath('pre-push'),
            ['upstream', '/tmp/remote.git'],
            {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
                    KODUS_CAPTURE: capturePath,
                },
            },
        );
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`pre-push exited ${code}: ${stderr}`));
            }
        });
        child.stdin.end(input);
    });

    // The hook deliberately detaches. Bound the wait for the fake child to
    // flush instead of assuming it completed before the hook returned.
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const content = await fs.readFile(capturePath, 'utf-8').catch(() => '');
        const lines = content.split('\n').filter(Boolean);
        const expected = input
            .split('\n')
            .filter((line) => line.includes(' refs/heads/'))
            .filter((line) => !line.includes(' refs/heads/kodus/trace/v1 '))
            .filter((line) => !/^\S+ 0+ /.test(line)).length;
        if (lines.length >= expected) {
            return lines;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return fs
        .readFile(capturePath, 'utf-8')
        .then((content) => content.split('\n').filter(Boolean))
        .catch(() => []);
}

describe('gitHooksService.install', () => {
    it('installs prepare-commit-msg and pre-push hooks', async () => {
        const result = await gitHooksService.install(hooksDir);

        expect(result.installed).toContain('prepare-commit-msg');
        expect(result.installed).toContain('pre-push');
        expect(result.alreadyInstalled).toHaveLength(0);

        const prepareContent = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(prepareContent).toContain('#!/bin/sh');
        expect(prepareContent).toContain(TRACE_HOOK_MARKER);
        expect(prepareContent).toContain('Kodus-Trace:');
        expect(prepareContent).toContain('kodus trace commit-trailer');

        const prePushContent = await fs.readFile(hookPath('pre-push'), 'utf-8');
        expect(prePushContent).toContain(TRACE_HOOK_MARKER);
        expect(prePushContent).toContain('kodus trace distill');
    });

    it('runs distillation detached so the push never waits on a model', async () => {
        await gitHooksService.install(hooksDir);
        const content = await fs.readFile(hookPath('pre-push'), 'utf-8');

        // Subshell + background + all streams closed: git has nothing to wait on.
        expect(content).toContain('kodus trace distill');
        expect(content).toMatch(/<\/dev\/null\s*&/);
        expect(content).toContain('>/dev/null 2>&1');
    });

    it('distills the destination branch and exact SHA from realistic pre-push stdin', async () => {
        const sha = '1'.repeat(40);
        const lines = await executePrePush(
            `refs/heads/feature-x ${sha} refs/heads/feature-x ${'2'.repeat(40)}\n`,
        );

        expect(lines).toEqual([
            `trace distill --branch feature-x --head ${sha} --remote upstream`,
        ]);
    });

    it('uses the destination name for an explicit HEAD:renamed-feature refspec', async () => {
        const sha = '3'.repeat(40);
        const lines = await executePrePush(
            `HEAD ${sha} refs/heads/renamed-feature ${'0'.repeat(40)}\n`,
        );

        expect(lines).toEqual([
            `trace distill --branch renamed-feature --head ${sha} --remote upstream`,
        ]);
    });

    it('schedules every pushed branch exactly once', async () => {
        const first = '4'.repeat(40);
        const second = '5'.repeat(40);
        const lines = await executePrePush(
            [
                `refs/heads/one ${first} refs/heads/one ${'0'.repeat(40)}`,
                `refs/heads/two ${second} refs/heads/two ${'6'.repeat(40)}`,
                '',
            ].join('\n'),
        );

        expect(lines.sort()).toEqual(
            [
                `trace distill --branch one --head ${first} --remote upstream`,
                `trace distill --branch two --head ${second} --remote upstream`,
            ].sort(),
        );
    });

    it('ignores tags, branch deletions, and the Trace branch', async () => {
        const zero = '0'.repeat(40);
        const sha = '7'.repeat(40);
        const lines = await executePrePush(
            [
                `refs/tags/v1 ${sha} refs/tags/v1 ${zero}`,
                `(delete) ${zero} refs/heads/old ${sha}`,
                `refs/heads/kodus/trace/v1 ${sha} refs/heads/kodus/trace/v1 ${zero}`,
                '',
            ].join('\n'),
        );

        expect(lines).toEqual([]);
    });

    it('hooks are executable', async () => {
        await gitHooksService.install(hooksDir);

        const prepareStat = await fs.stat(hookPath('prepare-commit-msg'));
        expect(prepareStat.mode & 0o100).toBeTruthy();

        const pushStat = await fs.stat(hookPath('pre-push'));
        expect(pushStat.mode & 0o100).toBeTruthy();
    });

    it('is idempotent — second install reports alreadyInstalled', async () => {
        await gitHooksService.install(hooksDir);
        const result = await gitHooksService.install(hooksDir);

        expect(result.installed).toHaveLength(0);
        expect(result.alreadyInstalled).toContain('prepare-commit-msg');
        expect(result.alreadyInstalled).toContain('pre-push');
    });

    it('appends to an existing non-kodus hook', async () => {
        const existing = '#!/bin/sh\necho "existing hook"\n';
        await fs.writeFile(hookPath('prepare-commit-msg'), existing);

        await gitHooksService.install(hooksDir);

        const content = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(content).toContain('echo "existing hook"');
        expect(content).toContain(TRACE_HOOK_MARKER);
    });

    it('replaces a hook block left by the previous release', async () => {
        const legacy = [
            '#!/bin/sh',
            'echo "mine"',
            '',
            '# kodus-session-hooks',
            'echo "Kody-Checkpoint stuff"',
            '# /kodus-session-hooks',
            '',
        ].join('\n');
        await fs.writeFile(hookPath('prepare-commit-msg'), legacy);

        await gitHooksService.install(hooksDir);

        const content = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(content).toContain('echo "mine"');
        expect(content).not.toContain('kodus-session-hooks');
        expect(content).not.toContain('Kody-Checkpoint');
        expect(content).toContain(TRACE_HOOK_MARKER);
    });

    it('removes the legacy post-commit block during upgrade', async () => {
        const legacy = [
            '#!/bin/sh',
            'echo "user-before"',
            '# kodus-session-hooks',
            'kodus sessions hooks post-commit',
            '# /kodus-session-hooks',
            'echo "user-after"',
        ].join('\n');
        await fs.writeFile(hookPath('post-commit'), legacy);

        await gitHooksService.install(hooksDir);

        const content = await fs.readFile(hookPath('post-commit'), 'utf-8');
        expect(content).toContain('echo "user-before"');
        expect(content).toContain('echo "user-after"');
        expect(content).not.toContain('kodus-session-hooks');
        expect(content).not.toContain('kodus sessions');
    });

    it('upgrades an existing Trace block instead of treating any marker as current', async () => {
        await fs.writeFile(
            hookPath('pre-push'),
            [
                '#!/bin/sh',
                'echo "user"',
                TRACE_HOOK_MARKER,
                'kodus trace distill --branch "$(git symbolic-ref --short HEAD)"',
                '# /kodus-trace',
            ].join('\n'),
        );

        await gitHooksService.install(hooksDir);
        const content = await fs.readFile(hookPath('pre-push'), 'utf-8');
        expect(content).toContain('echo "user"');
        expect(content).not.toContain('git symbolic-ref --short HEAD');
        expect(content).toContain('while read -r KODUS_LOCAL_REF');
        expect(content.match(/# kodus-trace/g)).toHaveLength(1);
    });

    it('preserves user content after a legacy block with a missing end marker', async () => {
        await fs.writeFile(
            hookPath('post-commit'),
            [
                '#!/bin/sh',
                '# kodus-session-hooks',
                'kodus sessions hooks post-commit',
                'echo "keep-me"',
            ].join('\n'),
        );

        await gitHooksService.install(hooksDir);
        const content = await fs.readFile(hookPath('post-commit'), 'utf-8');
        expect(content).toContain('echo "keep-me"');
        expect(content).not.toContain('kodus sessions');
    });

    it('collapses multiple old blocks and is byte-identical on the next enable', async () => {
        await fs.writeFile(
            hookPath('prepare-commit-msg'),
            [
                '#!/bin/sh',
                'echo user',
                '# kodus-session-hooks',
                'kodus sessions hooks one',
                '# /kodus-session-hooks',
                '# kodus-session-hooks',
                'kodus sessions hooks two',
                '# /kodus-session-hooks',
            ].join('\n'),
        );

        await gitHooksService.install(hooksDir);
        const once = await fs.readFile(hookPath('prepare-commit-msg'), 'utf-8');
        await gitHooksService.install(hooksDir);
        const twice = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(twice).toBe(once);
        expect(twice.match(/# kodus-trace/g)).toHaveLength(1);
        expect(twice).not.toContain('kodus-session-hooks');
    });
});

describe('gitHooksService.uninstall', () => {
    it('removes kodus sections from hooks', async () => {
        await gitHooksService.install(hooksDir);
        const result = await gitHooksService.uninstall(hooksDir);

        expect(result.removed).toContain('prepare-commit-msg');
        expect(result.removed).toContain('pre-push');

        // Hooks with only kodus content should be deleted
        await expect(
            fs.access(hookPath('prepare-commit-msg')),
        ).rejects.toThrow();
        await expect(fs.access(hookPath('pre-push'))).rejects.toThrow();
    });

    it('preserves non-kodus content when removing', async () => {
        const existing = '#!/bin/sh\necho "custom"\n';
        await fs.writeFile(hookPath('prepare-commit-msg'), existing);

        await gitHooksService.install(hooksDir);
        await gitHooksService.uninstall(hooksDir);

        const content = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(content).toContain('echo "custom"');
        expect(content).not.toContain(TRACE_HOOK_MARKER);
    });

    it('returns empty removed array when hooks do not exist', async () => {
        const result = await gitHooksService.uninstall(hooksDir);
        expect(result.removed).toHaveLength(0);
    });
});
