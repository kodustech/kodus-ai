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
    git(dir, ['config', 'core.abbrev', '7']);
    git(dir, ['config', 'diff.context', '3']);
    git(dir, ['config', 'diff.noprefix', 'false']);
    git(dir, ['config', 'diff.mnemonicPrefix', 'false']);
    git(dir, ['config', 'diff.renames', 'true']);
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

    it('keeps staged non-ASCII filenames when core.quotePath is enabled', async () => {
        const dir = createRepo();
        tempDirs.push(dir);

        git(dir, ['config', 'core.quotePath', 'true']);
        fs.writeFileSync(
            path.join(dir, 'ação.ts'),
            'const STAGED_UNICODE = true;\n',
        );
        git(dir, ['add', 'ação.ts']);
        fs.writeFileSync(
            path.join(dir, 'ação.ts'),
            'const STAGED_UNICODE = true;\nconst UNSTAGED_UNICODE = true;\n',
        );

        const gitService = await freshGitService(dir);
        process.chdir(dir);

        const contents = await gitService.getFullFileContents(undefined, {
            staged: true,
        });
        expect(contents.map((file) => file.path)).toEqual(['ação.ts']);
        expect(contents[0].status).toBe('added');
        expect(contents[0].content).toContain('STAGED_UNICODE');
        expect(contents[0].content).not.toContain('UNSTAGED_UNICODE');

        const explicit = await gitService.getFullFileContents(['ação.ts'], {
            staged: true,
        });
        expect(explicit.map((file) => file.path)).toEqual(['ação.ts']);
        expect(explicit[0].content).toContain('STAGED_UNICODE');
        expect(explicit[0].content).not.toContain('UNSTAGED_UNICODE');
    });

    it('preserves rename-with-edit hunk diff in getFullFileContents and multi-path getDiffForFiles', async () => {
        const dir = createRepo();
        tempDirs.push(dir);

        const initialLines = [
            'const line1 = 1;',
            'const line2 = 2;',
            'const line3 = 3;',
            'const line4 = 4;',
            'const line5 = 5;',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(dir, 'to-rename.ts'), initialLines);
        git(dir, ['add', 'to-rename.ts']);
        git(dir, ['commit', '-qm', 'seed multi-line rename source']);

        git(dir, ['mv', 'to-rename.ts', 'renamed-with-edit.ts']);
        fs.writeFileSync(
            path.join(dir, 'renamed-with-edit.ts'),
            `${initialLines}const STAGED_RENAME_EDIT = 6;\n`,
        );
        git(dir, ['add', 'renamed-with-edit.ts']);

        const gitService = await freshGitService(dir);
        process.chdir(dir);

        const expectedRenameDiff = [
            'diff --git a/to-rename.ts b/renamed-with-edit.ts',
            'similarity index 73%',
            'rename from to-rename.ts',
            'rename to renamed-with-edit.ts',
            'index c87a85d..2468ad5 100644',
            '--- a/to-rename.ts',
            '+++ b/renamed-with-edit.ts',
            '@@ -3,3 +3,4 @@ const line2 = 2;',
            ' const line3 = 3;',
            ' const line4 = 4;',
            ' const line5 = 5;',
            '+const STAGED_RENAME_EDIT = 6;',
            '',
        ].join('\n');

        const contents = await gitService.getFullFileContents(undefined, {
            staged: true,
        });
        expect(contents).toHaveLength(1);
        expect(contents[0].path).toBe('renamed-with-edit.ts');
        expect(contents[0].status).toBe('renamed');
        expect(contents[0].diff).toBe(expectedRenameDiff);

        const multiFileDiff = await gitService.getDiffForFiles(
            ['to-rename.ts', 'renamed-with-edit.ts'],
            { staged: true },
        );
        expect(multiFileDiff).toBe(expectedRenameDiff.trim());

        const overlappingDiff = await gitService.getDiffForFiles(
            ['renamed-with-edit.ts', './renamed-with-edit.ts'],
            { staged: true },
        );
        expect(overlappingDiff.match(/diff --git /g)?.length ?? 0).toBe(1);
    });

    it('handles stage-prefix filenames (1:sample.txt) and glob characters (a[1].txt)', async () => {
        const dir = createRepo();
        tempDirs.push(dir);

        fs.writeFileSync(
            path.join(dir, '1:sample.txt'),
            'const STAGE_PREFIX_NAME = true;\n',
        );
        fs.writeFileSync(
            path.join(dir, 'a[1].txt'),
            'const LITERAL_BRACKETS = true;\n',
        );
        fs.writeFileSync(
            path.join(dir, 'a1.txt'),
            'const GLOB_NEIGHBOR = true;\n',
        );
        git(dir, [
            'add',
            ':(literal)1:sample.txt',
            ':(literal)a[1].txt',
            'a1.txt',
        ]);

        const gitService = await freshGitService(dir);
        process.chdir(dir);

        const contents = await gitService.getFullFileContents(undefined, {
            staged: true,
        });
        const byPath = new Map(contents.map((file) => [file.path, file]));

        expect(byPath.get('1:sample.txt')?.content).toBe(
            'const STAGE_PREFIX_NAME = true;\n',
        );
        expect(byPath.get('1:sample.txt')?.diff).toBe(
            [
                'diff --git a/1:sample.txt b/1:sample.txt',
                'new file mode 100644',
                'index 0000000..21e3e3c',
                '--- /dev/null',
                '+++ b/1:sample.txt',
                '@@ -0,0 +1 @@',
                '+const STAGE_PREFIX_NAME = true;',
                '',
            ].join('\n'),
        );

        expect(byPath.get('a[1].txt')?.content).toBe(
            'const LITERAL_BRACKETS = true;\n',
        );
        expect(byPath.get('a[1].txt')?.diff).toBe(
            [
                'diff --git a/a[1].txt b/a[1].txt',
                'new file mode 100644',
                'index 0000000..cfd117e',
                '--- /dev/null',
                '+++ b/a[1].txt',
                '@@ -0,0 +1 @@',
                '+const LITERAL_BRACKETS = true;',
                '',
            ].join('\n'),
        );
    });

    it('reads staged diffs and contents from a nested cwd and respects diff.relative=true', async () => {
        const dir = createRepo();
        tempDirs.push(dir);

        const subDir = path.join(dir, 'src');
        fs.mkdirSync(subDir);
        fs.writeFileSync(
            path.join(dir, 'sibling.ts'),
            'const ROOT_SIBLING = "root";\n',
        );
        fs.writeFileSync(
            path.join(subDir, 'sibling.ts'),
            'const SUB_SIBLING = "sub";\n',
        );
        git(dir, ['add', 'sibling.ts', 'src/sibling.ts']);

        // 1. Default diff.relative (false) from nested subdirectory:
        const gitServiceDefault = await freshGitService(subDir);
        process.chdir(subDir);

        const defaultContents = await gitServiceDefault.getFullFileContents(
            undefined,
            { staged: true },
        );
        const defaultByPath = new Map(
            defaultContents.map((file) => [file.path, file]),
        );
        expect(defaultByPath.get('src/sibling.ts')?.content).toBe(
            'const SUB_SIBLING = "sub";\n',
        );
        expect(defaultByPath.get('src/sibling.ts')?.diff).toBe(
            [
                'diff --git a/src/sibling.ts b/src/sibling.ts',
                'new file mode 100644',
                'index 0000000..23c0018',
                '--- /dev/null',
                '+++ b/src/sibling.ts',
                '@@ -0,0 +1 @@',
                '+const SUB_SIBLING = "sub";',
                '',
            ].join('\n'),
        );
        expect(defaultByPath.get('sibling.ts')?.content).toBe(
            'const ROOT_SIBLING = "root";\n',
        );

        // 2. diff.relative=true from nested subdirectory:
        git(dir, ['config', 'diff.relative', 'true']);
        const gitServiceRelative = await freshGitService(subDir);
        process.chdir(subDir);

        const relativeContents = await gitServiceRelative.getFullFileContents(
            undefined,
            { staged: true },
        );
        expect(relativeContents.map((file) => file.path)).toEqual([
            'src/sibling.ts',
        ]);
        expect(relativeContents[0].content).toBe(
            'const SUB_SIBLING = "sub";\n',
        );
        expect(relativeContents[0].diff).toBe(
            [
                'diff --git a/sibling.ts b/sibling.ts',
                'new file mode 100644',
                'index 0000000..23c0018',
                '--- /dev/null',
                '+++ b/sibling.ts',
                '@@ -0,0 +1 @@',
                '+const SUB_SIBLING = "sub";',
                '',
            ].join('\n'),
        );
    });
});
