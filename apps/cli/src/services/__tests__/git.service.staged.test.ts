import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' });

function createRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-git-staged-'));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@kodus.io']);
    git(dir, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'tracked.ts'), 'const base = 1;\n');
    fs.writeFileSync(path.join(dir, 'other.ts'), 'const other = 1;\n');
    fs.writeFileSync(path.join(dir, 'to-delete.ts'), 'const doomed = 1;\n');
    fs.writeFileSync(path.join(dir, 'to-rename.ts'), 'const renamed = 1;\n');
    git(dir, ['add', '.']);
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

describe('gitService staged-only scope', () => {
    const originalCwd = process.cwd();
    const tempDirs: string[] = [];

    afterEach(() => {
        process.chdir(originalCwd);
        while (tempDirs.length > 0) {
            const dir = tempDirs.pop()!;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns only staged diffs from getDiffForFiles when staged is true', async () => {
        const dir = createRepo();
        tempDirs.push(dir);

        // Stage one change in tracked.ts, then make an unstaged edit on disk.
        fs.writeFileSync(
            path.join(dir, 'tracked.ts'),
            'const base = 1;\nconst STAGED_LINE = 2;\n',
        );
        git(dir, ['add', 'tracked.ts']);
        fs.writeFileSync(
            path.join(dir, 'tracked.ts'),
            'const base = 1;\nconst STAGED_LINE = 2;\nconst UNSTAGED_SAME = 3;\n',
        );

        // Make an unstaged-only change in other.ts.
        fs.writeFileSync(
            path.join(dir, 'other.ts'),
            'const other = 1;\nconst UNSTAGED_OTHER = 2;\n',
        );

        const gitService = await freshGitService(dir);
        process.chdir(dir);

        const stagedOnly = await gitService.getDiffForFiles(
            ['tracked.ts', 'other.ts'],
            { staged: true },
        );
        expect(stagedOnly).toContain('STAGED_LINE');
        expect(stagedOnly).not.toContain('UNSTAGED_SAME');
        expect(stagedOnly).not.toContain('UNSTAGED_OTHER');

        const unstagedOnlyFile = await gitService.getDiffForFiles(
            ['other.ts'],
            { staged: true },
        );
        expect(unstagedOnlyFile).toBe('');
    });

    it('reads only staged files and index contents in getFullFileContents', async () => {
        const dir = createRepo();
        tempDirs.push(dir);

        // Modified in index + further edited unstaged on disk.
        fs.writeFileSync(
            path.join(dir, 'tracked.ts'),
            'const base = 1;\nconst STAGED_MOD = 2;\n',
        );
        git(dir, ['add', 'tracked.ts']);
        fs.writeFileSync(
            path.join(dir, 'tracked.ts'),
            'const base = 1;\nconst STAGED_MOD = 2;\nconst UNSTAGED_MOD = 3;\n',
        );

        // Added in index + further edited unstaged on disk.
        fs.writeFileSync(
            path.join(dir, 'added.ts'),
            'const STAGED_ADD = true;\n',
        );
        git(dir, ['add', 'added.ts']);
        fs.writeFileSync(
            path.join(dir, 'added.ts'),
            'const STAGED_ADD = true;\nconst UNSTAGED_ADD = true;\n',
        );

        // Staged deletion + recreated untracked file on disk.
        git(dir, ['rm', '-q', 'to-delete.ts']);
        fs.writeFileSync(
            path.join(dir, 'to-delete.ts'),
            'const UNTRACKED_RECREATED = true;\n',
        );

        // Staged rename + unstaged edit to destination on disk.
        git(dir, ['mv', 'to-rename.ts', 'renamed.ts']);
        fs.writeFileSync(
            path.join(dir, 'renamed.ts'),
            'const renamed = 1;\nconst UNSTAGED_RENAMED = true;\n',
        );

        // Unstaged-only modification and untracked file.
        fs.writeFileSync(
            path.join(dir, 'other.ts'),
            'const other = 1;\nconst UNSTAGED_OTHER = 2;\n',
        );
        fs.writeFileSync(
            path.join(dir, 'untracked.ts'),
            'const UNTRACKED = true;\n',
        );

        const gitService = await freshGitService(dir);
        process.chdir(dir);

        const contents = await gitService.getFullFileContents(undefined, {
            staged: true,
        });

        expect(contents.map((file) => file.path).sort()).toEqual([
            'added.ts',
            'renamed.ts',
            'tracked.ts',
        ]);

        const byPath = new Map(contents.map((file) => [file.path, file]));

        expect(byPath.get('tracked.ts')?.status).toBe('modified');
        expect(byPath.get('tracked.ts')?.content).toContain('STAGED_MOD');
        expect(byPath.get('tracked.ts')?.content).not.toContain('UNSTAGED_MOD');
        expect(byPath.get('tracked.ts')?.diff).toContain('STAGED_MOD');
        expect(byPath.get('tracked.ts')?.diff).not.toContain('UNSTAGED_MOD');

        expect(byPath.get('added.ts')?.status).toBe('added');
        expect(byPath.get('added.ts')?.content).toContain('STAGED_ADD');
        expect(byPath.get('added.ts')?.content).not.toContain('UNSTAGED_ADD');

        expect(byPath.get('renamed.ts')?.status).toBe('renamed');
        expect(byPath.get('renamed.ts')?.content).toContain(
            'const renamed = 1;',
        );
        expect(byPath.get('renamed.ts')?.content).not.toContain(
            'UNSTAGED_RENAMED',
        );

        // Intersect explicit file arguments with staged changes only.
        const explicit = await gitService.getFullFileContents(
            ['./tracked.ts', 'other.ts', 'to-delete.ts'],
            { staged: true },
        );
        expect(explicit.map((file) => file.path)).toEqual(['tracked.ts']);
        expect(explicit[0].content).toContain('STAGED_MOD');
        expect(explicit[0].content).not.toContain('UNSTAGED_MOD');
    });
});
