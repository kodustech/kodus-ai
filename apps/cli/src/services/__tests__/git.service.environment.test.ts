import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitEnvironmentToKeep } from '../../utils/git-environment.js';

// Real git, real simple-git: simple-git 4 strips ambient GIT_* variables
// unless allowed, which is invisible to the mocked tests.

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', args, {
        cwd,
        env: { ...process.env, ...env },
        encoding: 'utf-8',
    });

function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-git-env-'));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 't@kodus.io']);
    git(dir, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-qm', 'init']);
    return dir;
}

async function freshGitService(cwd: string) {
    vi.resetModules();
    const previous = process.cwd();
    process.chdir(cwd);
    try {
        const { gitService } = await import('../git.service.js');
        return gitService;
    } finally {
        process.chdir(previous);
    }
}

const stagedFiles = (diff: string) =>
    [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]);

describe('gitService with the ambient git environment', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it('reads the index a pre-commit hook points GIT_INDEX_FILE at', async () => {
        const dir = repo();
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
        // What `git commit -a` does before running pre-commit: stage into a
        // temporary index, leaving the real one untouched.
        const tempIndex = path.join(dir, '.git', 'index.commit');
        fs.copyFileSync(path.join(dir, '.git', 'index'), tempIndex);
        git(dir, ['add', 'a.txt'], { GIT_INDEX_FILE: tempIndex });

        const gitService = await freshGitService(dir);
        process.env.GIT_INDEX_FILE = tempIndex;
        process.chdir(dir);
        try {
            expect(stagedFiles(await gitService.getStagedDiff())).toEqual([
                'a.txt',
            ]);
        } finally {
            process.chdir(saved.PWD ?? os.tmpdir());
        }
    });

    it('keeps the repository and env-config variables, and only those', () => {
        const keep = gitEnvironmentToKeep({
            GIT_CONFIG_KEY_0: 'safe.directory',
            GIT_CONFIG_VALUE_0: '*',
            GIT_SSH_COMMAND: 'ssh -i key',
            EDITOR: 'vim',
        });

        expect(keep).toEqual(
            expect.arrayContaining([
                'GIT_INDEX_FILE',
                'GIT_DIR',
                'GIT_WORK_TREE',
                'GIT_CONFIG_COUNT',
                'GIT_CONFIG_KEY_0',
                'GIT_CONFIG_VALUE_0',
            ]),
        );
        expect(keep).not.toContain('GIT_SSH_COMMAND');
        expect(keep).not.toContain('EDITOR');
    });
});
