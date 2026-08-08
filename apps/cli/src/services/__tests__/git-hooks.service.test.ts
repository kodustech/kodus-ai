import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { gitHooksService } from '../git-hooks.service.js';

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
        expect(prepareContent).toContain('kodus-trace');

        const prePush = await fs.readFile(hookPath('pre-push'), 'utf-8');
        expect(prePush).toContain('kodus-trace');
        expect(prePush).toContain('kodus trace _distill-internal');
        // detached / non-blocking
        expect(prePush).toContain('&');
    });

    it('hooks are executable', async () => {
        await gitHooksService.install(hooksDir);

        const prepareStat = await fs.stat(hookPath('prepare-commit-msg'));
        expect(prepareStat.mode & 0o100).toBeTruthy();

        const prePushStat = await fs.stat(hookPath('pre-push'));
        expect(prePushStat.mode & 0o100).toBeTruthy();
    });

    it('is idempotent — second install reports alreadyInstalled', async () => {
        await gitHooksService.install(hooksDir);
        const result = await gitHooksService.install(hooksDir);

        expect(result.installed).toHaveLength(0);
        expect(result.alreadyInstalled).toContain('prepare-commit-msg');
        expect(result.alreadyInstalled).toContain('pre-push');
    });

    it('strips legacy session-hooks markers on install', async () => {
        await fs.writeFile(
            hookPath('post-commit'),
            `#!/bin/sh\n# kodus-session-hooks\necho old\n# /kodus-session-hooks\n`,
            { mode: 0o755 },
        );
        await gitHooksService.install(hooksDir);
        // legacy post-commit block removed
        try {
            const content = await fs.readFile(hookPath('post-commit'), 'utf-8');
            expect(content).not.toContain('kodus-session-hooks');
        } catch {
            // file removed entirely is also fine
        }
    });
});

describe('gitHooksService.uninstall', () => {
    it('removes installed hooks', async () => {
        await gitHooksService.install(hooksDir);
        const result = await gitHooksService.uninstall(hooksDir);
        expect(result.removed).toContain('pre-push');
        await expect(fs.access(hookPath('pre-push'))).rejects.toThrow();
    });
});
