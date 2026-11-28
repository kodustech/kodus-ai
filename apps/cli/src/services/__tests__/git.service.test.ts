import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { gitService } from '../git.service.js';

describe('inferPlatform', () => {
    it('detects GitHub from HTTPS URL', () => {
        expect(
            gitService.inferPlatform('https://github.com/org/repo.git'),
        ).toBe('GITHUB');
    });

    it('detects GitHub from SSH URL', () => {
        expect(gitService.inferPlatform('git@github.com:org/repo.git')).toBe(
            'GITHUB',
        );
    });

    it('detects GitLab from HTTPS URL', () => {
        expect(
            gitService.inferPlatform('https://gitlab.com/org/repo.git'),
        ).toBe('GITLAB');
    });

    it('detects GitLab from SSH URL', () => {
        expect(gitService.inferPlatform('git@gitlab.com:org/repo.git')).toBe(
            'GITLAB',
        );
    });

    it('detects Bitbucket from HTTPS URL', () => {
        expect(
            gitService.inferPlatform('https://bitbucket.org/org/repo.git'),
        ).toBe('BITBUCKET');
    });

    it('detects Bitbucket from SSH URL', () => {
        expect(gitService.inferPlatform('git@bitbucket.org:org/repo.git')).toBe(
            'BITBUCKET',
        );
    });

    it('detects Azure DevOps from dev.azure.com URL', () => {
        expect(
            gitService.inferPlatform(
                'https://dev.azure.com/org/project/_git/repo',
            ),
        ).toBe('AZURE_REPOS');
    });

    it('detects Azure DevOps from visualstudio.com URL', () => {
        expect(
            gitService.inferPlatform(
                'https://org.visualstudio.com/project/_git/repo',
            ),
        ).toBe('AZURE_REPOS');
    });

    it('returns undefined for null', () => {
        expect(gitService.inferPlatform(null)).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
        expect(gitService.inferPlatform(undefined)).toBeUndefined();
    });

    it('returns undefined for unknown host', () => {
        expect(
            gitService.inferPlatform(
                'https://selfhosted.example.com/org/repo.git',
            ),
        ).toBeUndefined();
    });

    it('returns undefined when allowed host appears in URL path only', () => {
        expect(
            gitService.inferPlatform(
                'https://evil.example.com/github.com/org/repo.git',
            ),
        ).toBeUndefined();
        expect(
            gitService.inferPlatform(
                'https://evil.example.com/dev.azure.com/org/project/_git/repo',
            ),
        ).toBeUndefined();
    });

    it('returns undefined for deceptive subdomain hosts', () => {
        expect(
            gitService.inferPlatform(
                'https://github.com.evil.example.com/org/repo.git',
            ),
        ).toBeUndefined();
        expect(
            gitService.inferPlatform(
                'https://dev.azure.com.evil.example.com/org/project/_git/repo',
            ),
        ).toBeUndefined();
    });
});

describe('parseGitStatus', () => {
    it('maps A to added', () => {
        expect(gitService.parseGitStatus('A')).toBe('added');
    });

    it('maps D to deleted', () => {
        expect(gitService.parseGitStatus('D')).toBe('deleted');
    });

    it('maps R to renamed', () => {
        expect(gitService.parseGitStatus('R')).toBe('renamed');
    });

    it('maps M to modified', () => {
        expect(gitService.parseGitStatus('M')).toBe('modified');
    });

    it('maps unknown char to modified', () => {
        expect(gitService.parseGitStatus('X')).toBe('modified');
    });

    it('handles lowercase input', () => {
        expect(gitService.parseGitStatus('a')).toBe('added');
    });

    it('handles status with trailing info (e.g. R100)', () => {
        expect(gitService.parseGitStatus('R100')).toBe('renamed');
    });
});

describe('subdirectory path handling', () => {
    const originalCwd = process.cwd();
    const createdDirs: string[] = [];

    const runGit = (cwd: string, args: string[]) =>
        execFileSync('git', args, { cwd, encoding: 'utf-8' });

    afterEach(async () => {
        process.chdir(originalCwd);
        while (createdDirs.length > 0) {
            const dir = createdDirs.pop()!;
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    async function createNestedRepo({
        repositoryName,
        subdirectory = 'src',
    }: {
        repositoryName?: string;
        subdirectory?: string;
    } = {}) {
        const tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-git-subdir-'),
        );
        createdDirs.push(tempDir);
        const repoDir = repositoryName
            ? path.join(tempDir, repositoryName)
            : tempDir;
        if (repositoryName) {
            await fs.mkdir(repoDir);
        }

        runGit(repoDir, ['init', '-q', '-b', 'main']);
        runGit(repoDir, ['config', 'user.email', 'test@kodus.io']);
        runGit(repoDir, ['config', 'user.name', 'Test']);

        await fs.mkdir(path.join(repoDir, subdirectory), {
            recursive: true,
        });
        await fs.writeFile(path.join(repoDir, 'root.txt'), 'root v1\n');
        await fs.writeFile(
            path.join(repoDir, subdirectory, 'nested.txt'),
            'nested v1\n',
        );
        runGit(repoDir, ['add', '.']);
        runGit(repoDir, ['commit', '-qm', 'initial']);

        runGit(repoDir, ['checkout', '-qb', 'feature']);
        await fs.writeFile(
            path.join(repoDir, subdirectory, 'nested.txt'),
            'nested v2\n',
        );
        runGit(repoDir, ['add', path.join(subdirectory, 'nested.txt')]);
        runGit(repoDir, ['commit', '-qm', 'update nested']);

        await fs.writeFile(
            path.join(repoDir, 'root.txt'),
            'root v1\nroot v2\n',
        );
        await fs.writeFile(
            path.join(repoDir, subdirectory, 'nested.txt'),
            'nested v2\nnested v3\n',
        );

        return repoDir;
    }

    async function freshGitService(cwd: string) {
        vi.resetModules();
        process.chdir(cwd);
        const mod = await import('../git.service.js');
        return mod.gitService;
    }

    it('resolves repository-derived modified files and full contents identically from a subdirectory', async () => {
        const repoDir = await createNestedRepo();
        const subdir = path.join(repoDir, 'src');
        const expectedRootDiff = runGit(repoDir, [
            'diff',
            '--',
            'root.txt',
        ]).trim();
        const expectedNestedDiff = runGit(repoDir, [
            'diff',
            '--',
            'src/nested.txt',
        ]).trim();

        const rootGit = await freshGitService(repoDir);
        const rootModified = await rootGit.getModifiedFiles();
        const rootContents = await rootGit.getFullFileContents();

        const subdirGit = await freshGitService(subdir);
        const subdirModified = await subdirGit.getModifiedFiles();
        const subdirContents = await subdirGit.getFullFileContents();

        expect(subdirModified).toEqual(rootModified);
        expect(
            subdirModified.map((file) => ({
                file: file.file,
                additions: file.additions,
                deletions: file.deletions,
            })),
        ).toEqual([
            { file: 'root.txt', additions: 1, deletions: 0 },
            { file: 'src/nested.txt', additions: 1, deletions: 0 },
        ]);

        expect(subdirContents).toEqual(rootContents);
        expect(subdirContents).toEqual([
            {
                path: 'root.txt',
                content: 'root v1\nroot v2\n',
                status: 'modified',
                diff: expectedRootDiff,
            },
            {
                path: 'src/nested.txt',
                content: 'nested v2\nnested v3\n',
                status: 'modified',
                diff: expectedNestedDiff,
            },
        ]);
    });

    it('resolves repository-derived commit and branch diffs from a subdirectory', async () => {
        const repoDir = await createNestedRepo();
        const subdirGit = await freshGitService(path.join(repoDir, 'src'));
        const expectedCommitDiff = runGit(repoDir, [
            'diff',
            'HEAD^',
            'HEAD',
            '--',
            'src/nested.txt',
        ]);
        const expectedBranchDiff = runGit(repoDir, [
            'diff',
            'main...HEAD',
            '--',
            'src/nested.txt',
        ]);

        const commitContents = await subdirGit.getFullFileContents(undefined, {
            commit: 'HEAD',
        });
        const branchContents = await subdirGit.getFullFileContents(undefined, {
            branch: 'main',
        });

        expect(commitContents).toEqual([
            {
                path: 'src/nested.txt',
                content: 'nested v2\n',
                status: 'modified',
                diff: expectedCommitDiff,
            },
        ]);
        expect(branchContents).toEqual([
            {
                path: 'src/nested.txt',
                content: 'nested v2\n',
                status: 'modified',
                diff: expectedBranchDiff,
            },
        ]);
    });

    it('preserves cwd-relative semantics for explicit file paths from a subdirectory', async () => {
        const repoDir = await createNestedRepo();
        const subdir = path.join(repoDir, 'src');
        const subdirGit = await freshGitService(subdir);
        const expectedDiff = runGit(subdir, [
            'diff',
            '--',
            'nested.txt',
        ]).trim();

        const explicitContents = await subdirGit.getFullFileContents([
            'nested.txt',
        ]);

        expect(explicitContents).toEqual([
            {
                path: 'nested.txt',
                content: 'nested v2\nnested v3\n',
                status: 'modified',
                diff: expectedDiff,
            },
        ]);
    });

    it('respects diff.relative=true subdirectory scope and excludes outside files', async () => {
        const repoDir = await createNestedRepo();
        const subdir = path.join(repoDir, 'src');
        runGit(repoDir, ['config', 'diff.relative', 'true']);
        const subdirGit = await freshGitService(subdir);
        const expectedDiff = runGit(subdir, [
            'diff',
            '--',
            'nested.txt',
        ]).trim();

        const modified = await subdirGit.getModifiedFiles();
        const contents = await subdirGit.getFullFileContents();

        expect(modified.map((file) => file.file)).toEqual(['nested.txt']);
        expect(contents).toEqual([
            {
                path: 'nested.txt',
                content: 'nested v2\nnested v3\n',
                status: 'modified',
                diff: expectedDiff,
            },
        ]);
    });

    it('omits untracked files that are absent from the requested diff', async () => {
        const repoDir = await createNestedRepo();
        await fs.writeFile(
            path.join(repoDir, 'untracked-secret.txt'),
            'do not upload\n',
        );
        const subdirGit = await freshGitService(path.join(repoDir, 'src'));

        const modified = await subdirGit.getModifiedFiles();
        const contents = await subdirGit.getFullFileContents();

        expect(modified.map((file) => file.file)).toEqual([
            'root.txt',
            'src/nested.txt',
        ]);
        expect(contents.map((file) => file.path)).toEqual([
            'root.txt',
            'src/nested.txt',
        ]);
        expect(JSON.stringify(contents)).not.toContain('do not upload');
    });

    it('propagates unreadable diff.relative configuration', async () => {
        const repoDir = await createNestedRepo();
        runGit(repoDir, ['config', 'diff.relative', 'not-a-bool']);
        const subdirGit = await freshGitService(path.join(repoDir, 'src'));
        const getRepositoryReadContext = Reflect.get(
            subdirGit,
            'getRepositoryReadContext',
        ) as () => Promise<unknown>;

        await expect(getRepositoryReadContext.call(subdirGit)).rejects.toThrow(
            "fatal: bad boolean config value 'not-a-bool' for 'diff.relative'",
        );
    });

    it('preserves whitespace in repository root and subdirectory paths', async () => {
        const repoDir = await createNestedRepo({
            repositoryName: 'repo\r',
            subdirectory: ' src ',
        });
        const subdir = path.join(repoDir, ' src ');
        runGit(repoDir, ['config', 'diff.relative', 'true']);
        const subdirGit = await freshGitService(subdir);
        const expectedDiff = runGit(subdir, [
            'diff',
            '--',
            'nested.txt',
        ]).trim();

        const modified = await subdirGit.getModifiedFiles();
        const contents = await subdirGit.getFullFileContents();

        expect(
            modified.map((file) => ({
                file: file.file,
                additions: file.additions,
                deletions: file.deletions,
            })),
        ).toEqual([{ file: 'nested.txt', additions: 1, deletions: 0 }]);
        expect(contents).toEqual([
            {
                path: 'nested.txt',
                content: 'nested v2\nnested v3\n',
                status: 'modified',
                diff: expectedDiff,
            },
        ]);
    });
});
