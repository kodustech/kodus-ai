import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEV_STUB_DOWNLOAD_TOKEN, DevStubRepoTokenIssuer, DevStubRuntimeGit, devGitStubFile } from '../infrastructure/dev-stub-git.adapter';

const SHA = 'a'.repeat(40);
const repo = { organizationId: 'o', teamId: 't', repositoryId: 'stub-1', repositoryName: 'kodus-dev/sample-app' };

describe('dev Git stub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-stub-'));
    const file = join(dir, 'stub.json');
    writeFileSync(file, JSON.stringify({ repos: { 'stub-1': { branch: 'main', sha: SHA, files: { '.kodus/workspace.yaml': 'version: 1\n' } } } }));
    const real = { getDefaultBranchHead: jest.fn().mockResolvedValue({ status: 'not_found' }), readFileAtCommit: jest.fn().mockResolvedValue('real') } as any;

    it('is refused in production and off without the variable', () => {
        expect(() => devGitStubFile({ RUNTIME_DEV_GIT_STUB_FILE: file, NODE_ENV: 'production' })).toThrow(/refused in production/);
        expect(devGitStubFile({})).toBeUndefined();
        expect(devGitStubFile({ RUNTIME_DEV_GIT_STUB_FILE: file, NODE_ENV: 'development' })).toBe(file);
    });

    it('answers the stub repos and sends the others to the real adapter', async () => {
        const git = new DevStubRuntimeGit(file, real);
        await expect(git.getDefaultBranchHead(repo)).resolves.toEqual({ status: 'ok', branch: 'main', sha: SHA });
        await expect(git.readFileAtCommit({ ...repo, path: '.kodus/workspace.yaml', sha: SHA, maxBytes: 100 })).resolves.toBe('version: 1\n');
        await expect(git.readFileAtCommit({ ...repo, path: '.kodus/workspace.yaml', sha: 'b'.repeat(40), maxBytes: 100 })).resolves.toBeNull();
        await expect(git.getDefaultBranchHead({ ...repo, repositoryId: 'real-1' })).resolves.toEqual({ status: 'not_found' });
        const pr = await git.openPullRequestWithFiles({
            ...repo,
            baseBranch: 'main',
            branch: 'b',
            title: 't',
            body: 'b',
            commitMessage: 'm',
            files: [{ path: 'x', content: 'y' }],
        });
        expect(pr).toEqual({ number: 9001, url: 'http://dev-git-stub.invalid/kodus-dev/sample-app/pull/9001' });
        expect(readFileSync(`${file}.prs.jsonl`, 'utf8')).toContain('"number":9001');
    });

    it('issues the stub token only for stub repos', async () => {
        const issuer = new DevStubRepoTokenIssuer(file, { issue: jest.fn().mockResolvedValue('ghs_real') });
        await expect(issuer.issue(repo)).resolves.toBe(DEV_STUB_DOWNLOAD_TOKEN);
        await expect(issuer.issue({ ...repo, repositoryId: 'real-1' })).resolves.toBe('ghs_real');
    });
});
