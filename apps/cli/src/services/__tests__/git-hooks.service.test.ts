import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { gitHooksService } from '../git-hooks.service.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-git-hooks-'));
    await fs.mkdir(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function hookPath(name: string): string {
    return path.join(tmpDir, '.git', 'hooks', name);
}

describe('gitHooksService.install', () => {
    it('installs prepare-commit-msg and post-commit hooks', async () => {
        const result = await gitHooksService.install(tmpDir);

        expect(result.installed).toContain('prepare-commit-msg');
        expect(result.installed).toContain('post-commit');
        expect(result.alreadyInstalled).toHaveLength(0);

        const prepareContent = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(prepareContent).toContain('#!/bin/sh');
        expect(prepareContent).toContain('kodus-session-hooks');
        expect(prepareContent).toContain('Kody-Checkpoint');

        const postContent = await fs.readFile(hookPath('post-commit'), 'utf-8');
        expect(postContent).toContain('kodus-session-hooks');
        expect(postContent).toContain('kodus sessions hooks claude-code stop');
    });

    it('hooks are executable', async () => {
        await gitHooksService.install(tmpDir);

        const prepareStat = await fs.stat(hookPath('prepare-commit-msg'));
        expect(prepareStat.mode & 0o100).toBeTruthy();

        const postStat = await fs.stat(hookPath('post-commit'));
        expect(postStat.mode & 0o100).toBeTruthy();
    });

    it('is idempotent — second install reports alreadyInstalled', async () => {
        await gitHooksService.install(tmpDir);
        const result = await gitHooksService.install(tmpDir);

        expect(result.installed).toHaveLength(0);
        expect(result.alreadyInstalled).toContain('prepare-commit-msg');
        expect(result.alreadyInstalled).toContain('post-commit');
    });

    it('appends to existing non-kodus hook', async () => {
        const existing = '#!/bin/sh\necho "existing hook"\n';
        await fs.writeFile(hookPath('prepare-commit-msg'), existing);

        await gitHooksService.install(tmpDir);

        const content = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(content).toContain('echo "existing hook"');
        expect(content).toContain('kodus-session-hooks');
    });
});

describe('gitHooksService.uninstall', () => {
    it('removes kodus sections from hooks', async () => {
        await gitHooksService.install(tmpDir);
        const result = await gitHooksService.uninstall(tmpDir);

        expect(result.removed).toContain('prepare-commit-msg');
        expect(result.removed).toContain('post-commit');

        // Hooks with only kodus content should be deleted
        await expect(
            fs.access(hookPath('prepare-commit-msg')),
        ).rejects.toThrow();
        await expect(fs.access(hookPath('post-commit'))).rejects.toThrow();
    });

    it('preserves non-kodus content when removing', async () => {
        const existing = '#!/bin/sh\necho "custom"\n';
        await fs.writeFile(hookPath('prepare-commit-msg'), existing);

        // Install (appends)
        await gitHooksService.install(tmpDir);

        // Uninstall (removes only kodus section)
        await gitHooksService.uninstall(tmpDir);

        const content = await fs.readFile(
            hookPath('prepare-commit-msg'),
            'utf-8',
        );
        expect(content).toContain('echo "custom"');
        expect(content).not.toContain('kodus-session-hooks');
    });

    it('returns empty removed array when hooks do not exist', async () => {
        const result = await gitHooksService.uninstall(tmpDir);
        expect(result.removed).toHaveLength(0);
    });
});
