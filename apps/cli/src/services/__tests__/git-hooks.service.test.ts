import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
        expect(content).toMatch(/\(kodus trace distill[^\n]*&\s*\)/);
        expect(content).toContain('>/dev/null 2>&1');
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
