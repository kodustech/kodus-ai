import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';

import { CodeManagementRuntimeGitAdapter } from '../infrastructure/code-management-git.adapter';

// Environments store the repository as owner/repo (the integration's
// full_name); the platform calls take the repo name, owner apart. Passing the
// full name made GitHub look for owner/owner/repo and every PR lookup 404.
describe('CodeManagementRuntimeGitAdapter: repository names', () => {
    const calls: any[] = [];
    const codeManagement = {
        getPullRequest: async (input: any) => {
            calls.push(['getPullRequest', input.repository]);
            return { head: { sha: 'a'.repeat(40), repo: { id: 1 } }, base: { sha: 'b'.repeat(40), repo: { id: 1 } }, state: PullRequestState.OPENED, user: { id: 9, login: 'dev' } };
        },
        getFilesByPullRequestId: async (input: any) => {
            calls.push(['getFilesByPullRequestId', input.repository]);
            return [{ filename: 'src/a.ts', patch: '@@' }];
        },
    };
    const adapter = new CodeManagementRuntimeGitAdapter(codeManagement as any);
    const input = { organizationId: 'o', teamId: 't', repositoryId: '42', repositoryName: 'acme/shop', prNumber: 7 };

    beforeEach(() => (calls.length = 0));

    it('splits owner/repo for the PR head and the diff', async () => {
        const head = await adapter.getPullRequestHead(input);
        await adapter.getPullRequestDiff({ ...input, headSha: 'a'.repeat(40) });
        expect(calls).toEqual([
            ['getPullRequest', { id: '42', owner: 'acme', name: 'shop' }],
            ['getFilesByPullRequestId', { id: '42', owner: 'acme', name: 'shop' }],
        ]);
        expect(head).toMatchObject({ headSha: 'a'.repeat(40), fork: false, state: 'open', authorLogin: 'dev' });
    });

    it('keeps a bare repo name as it is', async () => {
        await adapter.getPullRequestHead({ ...input, repositoryName: 'shop' });
        expect(calls[0][1]).toEqual({ id: '42', name: 'shop' });
    });
});

describe('CodeManagementRuntimeGitAdapter: facts from the Git API (ADR-057)', () => {
    const input = { organizationId: 'o', teamId: 't', repositoryId: '42', repositoryName: 'acme/shop', prNumber: 7 };
    const pr = (patch: any = {}) => ({
        head: { sha: 'a'.repeat(40), repo: { id: 1 } },
        base: { sha: 'b'.repeat(40), repo: { id: 1 } },
        state: PullRequestState.OPENED,
        user: { id: 9, login: 'dev' },
        ...patch,
    });

    it('takes the base branch only from the native PR target ref', async () => {
        const adapter = new CodeManagementRuntimeGitAdapter({
            getPullRequest: async () => pr({ head: { sha: 'a'.repeat(40), ref: 'feature/other', repo: { id: 1 } }, base: { sha: 'b'.repeat(40), ref: 'release/2026', repo: { id: 1, defaultBranch: 'main' } } }),
        } as any);
        expect(await adapter.getPullRequestHead(input)).toMatchObject({ baseBranch: 'release/2026' });
    });

    it.each([undefined, null, '', ' branch ', 'bad\nref', 'x'.repeat(1025)])('omits absent or unusable native ref metadata, never inferring a branch (%j)', async (ref) => {
        const adapter = new CodeManagementRuntimeGitAdapter({
            getPullRequest: async () => pr({ head: { sha: 'a'.repeat(40), ref: 'feature/head', repo: { id: 1 } }, base: { sha: 'b'.repeat(40), ref, repo: { id: 1, defaultBranch: 'main' } } }),
        } as any);
        const head = await adapter.getPullRequestHead(input);
        expect(head).toMatchObject({ baseSha: 'b'.repeat(40) });
        expect(head).not.toHaveProperty('baseBranch');
    });

    it('reads draft, labels and a bot author from the PR the API returns, asking for labels', async () => {
        let asked: any;
        const adapter = new CodeManagementRuntimeGitAdapter({
            getPullRequest: async (i: any) => ((asked = i), pr({ isDraft: true, labels: ['runtime', 7], user: { id: 1, login: 'renovate[bot]' } })),
        } as any);
        expect(await adapter.getPullRequestHead(input)).toMatchObject({ draft: true, labels: ['runtime'], authorIsBot: true, authorLogin: 'renovate[bot]' });
        expect(asked.includeLabels).toBe(true);
    });

    it('says when the diff was cut (too many files or a patch too big), never hides it', async () => {
        const many = Array.from({ length: 501 }, (_, i) => ({ filename: `src/f${i}.md`, patch: '@@' }));
        const adapter = new CodeManagementRuntimeGitAdapter({ getFilesByPullRequestId: async () => many } as any);
        const diff = await adapter.getPullRequestDiff({ ...input, headSha: 'a'.repeat(40) });
        expect(diff.files).toHaveLength(500);
        expect(diff.truncated).toBe(true);

        const big = new CodeManagementRuntimeGitAdapter({ getFilesByPullRequestId: async () => [{ filename: 'a.md', patch: 'x'.repeat(1_000_001) }] } as any);
        expect((await big.getPullRequestDiff({ ...input, headSha: 'a'.repeat(40) })).truncated).toBe(true);

        const small = new CodeManagementRuntimeGitAdapter({ getFilesByPullRequestId: async () => [{ filename: 'a.md', patch: '@@' }] } as any);
        expect(await small.getPullRequestDiff({ ...input, headSha: 'a'.repeat(40) })).toEqual({ files: [{ path: 'a.md', patch: '@@' }], truncated: false });
    });

    it('names the recipe files the PR changes from the whole list, past the cut and by a rename (S-19)', async () => {
        const many = [
            ...Array.from({ length: 500 }, (_, i) => ({ filename: `src/f${i}.md`, patch: '@@' })),
            { filename: '.kodus/workspace.yaml', patch: '@@' },
            { filename: 'ops/old-recipe.yaml', previous_filename: '.kodus/workspace.runtime.yaml', status: 'renamed', patch: '' },
        ];
        const adapter = new CodeManagementRuntimeGitAdapter({ getFilesByPullRequestId: async () => many } as any);
        const diff = await adapter.getPullRequestDiff({ ...input, headSha: 'a'.repeat(40) });
        expect(diff.truncated).toBe(true);
        expect(diff.files.some((f) => f.path === '.kodus/workspace.yaml')).toBe(false);
        expect(diff.recipeFiles).toEqual(['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml']);

        const none = new CodeManagementRuntimeGitAdapter({ getFilesByPullRequestId: async () => [{ filename: 'kodus/workspace.yaml', patch: '@@' }] } as any);
        expect(await none.getPullRequestDiff({ ...input, headSha: 'a'.repeat(40) })).not.toHaveProperty('recipeFiles');
    });

    it('reads the post-change content of changed code files at the head, so routes can be extracted', async () => {
        const reads: any[] = [];
        const adapter = new CodeManagementRuntimeGitAdapter({
            getFilesByPullRequestId: async () => [
                { filename: 'src/orders.controller.ts', patch: '@@' },
                { filename: 'src/gone.ts', patch: '@@', status: 'removed' },
                { filename: 'README.md', patch: '@@' },
            ],
            getFileContentAtRef: async (i: any) => (reads.push([i.path, i.ref]), '@Controller("orders") class C {}'),
        } as any);
        const diff = await adapter.getPullRequestDiff({ ...input, headSha: 'c'.repeat(40) });
        expect(reads).toEqual([['src/orders.controller.ts', 'c'.repeat(40)]]);
        expect(diff.files[0].content).toContain('@Controller');
        expect(diff.files[1]).not.toHaveProperty('content');
        expect(diff.files[1]).not.toHaveProperty('removed');
    });

    it('reads the content of code files in other languages too (a Go handler, a Python view)', async () => {
        const reads: string[] = [];
        const adapter = new CodeManagementRuntimeGitAdapter({
            getFilesByPullRequestId: async () => [
                { filename: 'pkg/api/health.go', patch: '@@' },
                { filename: 'app/views.py', patch: '@@' },
                { filename: 'docs/guide.md', patch: '@@' },
            ],
            getFileContentAtRef: async (i: any) => (reads.push(i.path), 'package api'),
        } as any);
        await adapter.getPullRequestDiff({ ...input, headSha: 'c'.repeat(40) });
        expect(reads.sort()).toEqual(['app/views.py', 'pkg/api/health.go']);
    });

    it('org membership: a match by id or login is true, an empty or failed member list is unknown', async () => {
        const members = [{ id: 42, name: 'Maria' }];
        const adapter = new CodeManagementRuntimeGitAdapter({ getListMembers: async () => members } as any);
        expect(await adapter.isOrganizationMember({ organizationId: 'o', teamId: 't', identity: { login: 'maria' } })).toBe(true);
        expect(await adapter.isOrganizationMember({ organizationId: 'o', teamId: 't', identity: { id: '42' } })).toBe(true);
        expect(await adapter.isOrganizationMember({ organizationId: 'o', teamId: 't', identity: { login: 'stranger' } })).toBe(false);
        expect(await new CodeManagementRuntimeGitAdapter({ getListMembers: async () => [] } as any).isOrganizationMember({ organizationId: 'o', teamId: 't', identity: { login: 'maria' } })).toBeUndefined();
        expect(
            await new CodeManagementRuntimeGitAdapter({ getListMembers: async () => Promise.reject(new Error('rate limited')) } as any).isOrganizationMember({
                organizationId: 'o',
                teamId: 't',
                identity: { login: 'maria' },
            }),
        ).toBeUndefined();
    });
});
