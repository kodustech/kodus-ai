import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('getDiffForCommit', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
        }
    });

    function runGit(cwd: string, args: string[]): string {
        return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
    }

    function createRepo(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-git-svc-'));
        tempDirs.push(dir);
        runGit(dir, ['init', '-q', '-b', 'main']);
        runGit(dir, ['config', 'user.email', 'test@kodus.io']);
        runGit(dir, ['config', 'user.name', 'Test']);
        runGit(dir, ['config', 'commit.gpgsign', 'false']);
        return dir;
    }

    async function freshGitService(cwd: string) {
        vi.resetModules();
        const previous = process.cwd();
        process.chdir(cwd);
        try {
            const { gitService: svc } = await import('../git.service.js');
            return svc;
        } finally {
            process.chdir(previous);
        }
    }

    it('diffs a root commit without emitting a commit header', async () => {
        const dir = createRepo();
        fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
        fs.mkdirSync(path.join(dir, 'nested'));
        fs.writeFileSync(
            path.join(dir, 'nested/b.ts'),
            'export const b = 2;\n',
        );
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-qm', 'initial']);
        const rootSha = runGit(dir, ['rev-parse', 'HEAD']);

        const svc = await freshGitService(dir);
        const rootDiff = await svc.getDiffForCommit(rootSha);

        expect(rootDiff.startsWith('diff --git ')).toBe(true);
        expect(rootDiff).toContain('a.ts');
        expect(rootDiff).toContain('+export const a = 1;');
        expect(rootDiff).toContain('nested/b.ts');
    });

    it('returns an empty diff for an empty root commit', async () => {
        const dir = createRepo();
        runGit(dir, ['commit', '--allow-empty', '-qm', 'empty initial']);
        const rootSha = runGit(dir, ['rev-parse', 'HEAD']);

        const svc = await freshGitService(dir);
        expect(await svc.getDiffForCommit(rootSha)).toBe('');
    });

    it('preserves ordinary rename and merge first-parent diffs', async () => {
        const dir = createRepo();
        runGit(dir, ['config', 'diff.renames', 'true']);
        fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
        fs.mkdirSync(path.join(dir, 'nested'));
        fs.writeFileSync(
            path.join(dir, 'nested/b.ts'),
            'export const b = 2;\n',
        );
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-qm', 'initial']);
        const rootSha = runGit(dir, ['rev-parse', 'HEAD']);

        fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 10;\n');
        runGit(dir, ['mv', 'nested/b.ts', 'nested/b-renamed.ts']);
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-qm', 'second']);
        const ordinarySha = runGit(dir, ['rev-parse', 'HEAD']);

        runGit(dir, ['checkout', '-qb', 'feature', rootSha]);
        fs.writeFileSync(path.join(dir, 'feat.ts'), 'export const f = 3;\n');
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-qm', 'feature']);
        runGit(dir, ['checkout', '-q', 'main']);
        runGit(dir, ['merge', '--no-ff', '-qm', 'merge feature', 'feature']);
        const mergeSha = runGit(dir, ['rev-parse', 'HEAD']);

        const svc = await freshGitService(dir);

        const ordinaryDiff = await svc.getDiffForCommit(ordinarySha);
        expect(ordinaryDiff).toContain('-export const a = 1;');
        expect(ordinaryDiff).toContain('+export const a = 10;');
        expect(ordinaryDiff).toContain('rename from nested/b.ts');

        const mergeDiff = await svc.getDiffForCommit(mergeSha);
        expect(mergeDiff).toContain('feat.ts');
        expect(mergeDiff).not.toContain('export const a = 10;');
    });

    it('rejects invalid commits and shallow-clone boundary commits', async () => {
        const dir = createRepo();
        fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-qm', 'initial']);

        fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
        runGit(dir, ['add', '.']);
        runGit(dir, ['commit', '-qm', 'second']);
        const secondSha = runGit(dir, ['rev-parse', 'HEAD']);

        const svc = await freshGitService(dir);
        await expect(svc.getDiffForCommit('deadbeef')).rejects.toThrow(
            /ambiguous argument|unknown revision/i,
        );

        const shallowDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-git-shallow-'),
        );
        tempDirs.push(shallowDir);
        execFileSync(
            'git',
            [
                'clone',
                '--quiet',
                '--depth',
                '1',
                pathToFileURL(dir).href,
                shallowDir,
            ],
            { encoding: 'utf-8' },
        );
        const shallowSvc = await freshGitService(shallowDir);
        await expect(shallowSvc.getDiffForCommit(secondSha)).rejects.toThrow(
            /ambiguous argument|unknown revision/i,
        );
    });
});
