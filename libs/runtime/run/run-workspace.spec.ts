import { refsDigest } from '@libs/runtime/contracts/workspace';

import { RuntimeRunRequestedSchema, type RuntimeRunRequested } from './run-messages';
import { blockerAliasOf, claimShaOf, memberAliasOfReason, memberTokensOf, repoTokensOf, withMemberTokens, runClaimWorkspace, setupClaimWorkspace, setupRefsDigest, workspaceNeedsError, workspaceSideOf } from './run-workspace';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);

const pr = { number: 7, baseSha: A, headSha: B, fork: false };

const tokens = { repoToken: 'sealed:v1:own-base', prRepoToken: 'sealed:v1:own-pr' };

describe('runClaimWorkspace', () => {
    it('is undefined for a Run of one repository', () => {
        expect(runClaimWorkspace({ ...tokens })).toBeUndefined();
        expect(claimShaOf({ pullRequest: pr }, 'base')).toBe(A);
        expect(claimShaOf({ pullRequest: pr }, 'pr')).toBe(B);
    });

    it('a PR in the primary: the primary fetches with the request tokens, each member with its own, per side', () => {
        const ws = runClaimWorkspace({
            ...tokens,
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary', baseSha: A, headSha: B, source: 'pull_request' },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member', baseSha: C, headSha: C, source: 'default_branch', sealedRepoToken: 'sealed:v1:bill-base', sealedPrRepoToken: 'sealed:v1:bill-pr' },
                { repositoryId: 'r-web', fullName: 'acme/web', alias: 'web', role: 'member', baseSha: D, headSha: E, source: 'paired', pairedPrNumber: 42, sealedRepoToken: 'sealed:v1:web-base' },
            ],
        })!;
        expect(ws.primary).toEqual({ repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', base: { sha: A, sealedToken: 'sealed:v1:own-base' }, pr: { sha: B, sealedToken: 'sealed:v1:own-pr' } });
        expect(ws.members).toEqual([
            { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', base: { sha: C, sealedToken: 'sealed:v1:bill-base' }, pr: { sha: C, sealedToken: 'sealed:v1:bill-pr' } },
            // No PR-side token of its own: the base's, as prRepoToken falls back to repoToken.
            { repositoryId: 'r-web', fullName: 'acme/web', alias: 'web', base: { sha: D, sealedToken: 'sealed:v1:web-base' }, pr: { sha: E, sealedToken: 'sealed:v1:web-base' } },
        ]);
    });

    it('a PR in a member: the claim is of the primary at its pinned commit, the PR repository is a member with the request tokens', () => {
        const req = {
            ...tokens,
            pullRequest: pr,
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary' as const, baseSha: C, headSha: C, source: 'default_branch' as const, sealedRepoToken: 'sealed:v1:app-base', sealedPrRepoToken: 'sealed:v1:app-pr' },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member' as const, baseSha: A, headSha: B, source: 'pull_request' as const },
            ],
        };
        const ws = runClaimWorkspace(req)!;
        expect(ws.primary).toMatchObject({ alias: 'app', base: { sha: C, sealedToken: 'sealed:v1:app-base' }, pr: { sha: C, sealedToken: 'sealed:v1:app-pr' } });
        expect(ws.members).toEqual([{ repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', base: { sha: A, sealedToken: 'sealed:v1:own-base' }, pr: { sha: B, sealedToken: 'sealed:v1:own-pr' } }]);
        expect(claimShaOf(req, 'base')).toBe(C);
        expect(claimShaOf(req, 'pr')).toBe(C);
    });

    it('a member without any token of its own has none on either side (the acquire refuses it)', () => {
        const ws = runClaimWorkspace({
            repoToken: 'sealed:v1:own',
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary', baseSha: A, headSha: B, source: 'pull_request' },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member', baseSha: C, headSha: C, source: 'default_branch' },
            ],
        })!;
        expect(ws.primary.pr.sealedToken).toBe('sealed:v1:own');
        expect(ws.members[0].base).toEqual({ sha: C });
        expect(ws.members[0].pr).toEqual({ sha: C });
    });

    it('agrees with the request schema on what a valid workspace is', () => {
        const req: RuntimeRunRequested = {
            runId: '6f0f1a5e-2a43-4f43-9c11-0d4f7f6b8a10',
            attempt: 1,
            correlationId: '6f0f1a5e-2a43-4f43-9c11-0d4f7f6b8a11',
            requestedAt: '2026-11-11T10:00:00.000Z',
            organizationId: 'org-1',
            teamId: 'team-1',
            repository: { id: 'r-app', name: 'app', fullName: 'acme/app' },
            pullRequest: pr,
            environment: { environmentId: 'env-1', imageId: 'latest', expose: [] },
            diff: [],
            repoToken: 'sealed:v1:x',
            runToken: 'sealed:v1:y',
            trigger: 'pull_request',
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary', baseSha: A, headSha: B, source: 'pull_request' },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member', baseSha: C, headSha: C, source: 'default_branch', sealedRepoToken: 'sealed:v1:z' },
            ],
        };
        const parsed = RuntimeRunRequestedSchema.safeParse(req);
        expect(parsed.success).toBe(true);
        expect(runClaimWorkspace(parsed.data!)?.members.map((m) => m.alias)).toEqual(['billing']);
    });
});

describe('setupClaimWorkspace', () => {
    it('every repository at its default-branch head with its own token, the same on every side', () => {
        const ws = setupClaimWorkspace({
            repoToken: 'sealed:v1:cmd',
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary', sha: A, branch: 'main', sealedRepoToken: 'sealed:v1:app' },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member', sha: C, branch: 'trunk', sealedRepoToken: 'sealed:v1:bill' },
            ],
        })!;
        expect(ws.primary).toMatchObject({ alias: 'app', base: { sha: A, sealedToken: 'sealed:v1:app' } });
        expect(ws.members).toEqual([{ repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', base: { sha: C, sealedToken: 'sealed:v1:bill' }, pr: { sha: C, sealedToken: 'sealed:v1:bill' } }]);
        expect(workspaceSideOf('setup')).toBe('base');
        expect(setupClaimWorkspace({ repoToken: 'sealed:v1:cmd' })).toBeUndefined();
    });

    it('the bake key covers every repository, the primary at the commit the setup booted', () => {
        const cmd = {
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary' as const, sha: A, branch: 'main', sealedRepoToken: 'sealed:v1:app' },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member' as const, sha: C, branch: 'main', sealedRepoToken: 'sealed:v1:bill' },
            ],
        };
        expect(setupRefsDigest(cmd, A, 'sha256:recipe')).toBe(refsDigest([{ repositoryId: 'r-app', sha: A }, { repositoryId: 'r-bill', sha: C }], 'sha256:recipe'));
        expect(setupRefsDigest(cmd, A, 'sha256:recipe')).not.toBe(setupRefsDigest(cmd, B, 'sha256:recipe'));
        expect(setupRefsDigest({}, A, 'sha256:recipe')).toBeUndefined();
        // A workspace of the primary alone carries no repos: its bake is keyed as one repository's.
        expect(setupRefsDigest({ workspace: [cmd.workspace[0]] }, A, 'sha256:recipe')).toBeUndefined();
    });
});

describe('workspaceNeedsError', () => {
    const ws = [
        { fullName: 'acme/app', alias: 'app', role: 'primary' },
        { fullName: 'acme/billing', alias: 'billing', role: 'member' },
    ];

    it('passes needs that are members under their alias, and no needs at all', () => {
        expect(workspaceNeedsError([{ repo: 'Acme/Billing', alias: 'billing' }], ws)).toBeUndefined();
        expect(workspaceNeedsError(undefined, ws)).toBeUndefined();
    });

    it('names the repository a need is wrong about', () => {
        expect(workspaceNeedsError([{ repo: 'acme/ledger', alias: 'ledger' }], ws)).toEqual({ alias: 'ledger', message: expect.stringContaining('not a repository of this environment') });
        expect(workspaceNeedsError([{ repo: 'acme/ledger', alias: 'billing' }], ws)).toEqual({ alias: 'billing', message: expect.stringContaining('billing is acme/billing') });
        expect(workspaceNeedsError([{ repo: 'acme/app', alias: 'core' }], ws)).toEqual({ alias: 'app', message: expect.stringContaining("environment's own repository") });
    });
});

describe('blockerAliasOf', () => {
    it('reads a well-formed alias only', () => {
        expect(blockerAliasOf({ kind: 'other_repo', signature: 's', message: 'm', alias: 'billing' })).toBe('billing');
        expect(blockerAliasOf({ kind: 'other_repo', signature: 's', message: 'm', alias: '../etc' })).toBeUndefined();
        expect(blockerAliasOf({ kind: 'other_repo', signature: 's', message: 'm' })).toBeUndefined();
        expect(blockerAliasOf(undefined)).toBeUndefined();
    });
});

describe('memberAliasOfReason', () => {
    it("reads the cell's `repository <alias>: ` prefix, only for a repository of the claim", () => {
        const repos = [{ alias: 'billing' }];
        expect(memberAliasOfReason('repository billing: fetch failed with 401', repos)).toBe('billing');
        expect(memberAliasOfReason('repository ledger: fetch failed', repos)).toBeUndefined();
        expect(memberAliasOfReason('compose up failed: repository billing: x', repos)).toBeUndefined();
        expect(memberAliasOfReason('repository billing: x', undefined)).toBeUndefined();
        expect(memberAliasOfReason(undefined, repos)).toBeUndefined();
    });
});

describe('the member tokens of a fork approval', () => {
    const ws = [
        { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary' as const, baseSha: A, headSha: B, source: 'pull_request' as const },
        { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member' as const, baseSha: C, headSha: C, source: 'default_branch' as const, sealedRepoToken: 'sealed:v1:old-b', sealedPrRepoToken: 'sealed:v1:old-bp' },
        { repositoryId: 'r-web', fullName: 'acme/web', alias: 'web', role: 'member' as const, baseSha: D, headSha: D, source: 'default_branch' as const, sealedRepoToken: 'sealed:v1:old-w' },
    ];

    it('replace every member token, and drop the ones the approval leaves out', () => {
        const out = withMemberTokens({ workspace: ws }, { workspace: [{ repositoryId: 'r-bill', sealedRepoToken: 'sealed:v1:new-b', sealedPrRepoToken: 'sealed:v1:new-bp' }] });
        expect(out.workspace![0]).toEqual(ws[0]);
        expect(out.workspace![1]).toMatchObject({ alias: 'billing', sealedRepoToken: 'sealed:v1:new-b', sealedPrRepoToken: 'sealed:v1:new-bp' });
        expect(out.workspace![2]).not.toHaveProperty('sealedRepoToken');
        expect(memberTokensOf(out)).toEqual([{ repositoryId: 'r-bill', sealedRepoToken: 'sealed:v1:new-b', sealedPrRepoToken: 'sealed:v1:new-bp' }]);
    });

    it('leave a request alone without an approval or a workspace', () => {
        const req = { workspace: ws };
        expect(withMemberTokens(req, undefined)).toBe(req);
        const one = { repoToken: 'x' } as { repoToken: string; workspace?: typeof ws };
        expect(withMemberTokens(one, { workspace: [] as never })).toBe(one);
        expect(repoTokensOf(undefined)).toEqual({});
        expect(repoTokensOf({ repoToken: 'a', runToken: 'b', workspace: [{ repositoryId: 'r', sealedRepoToken: 'c' }] })).toEqual({ repoToken: 'a', runToken: 'b' });
        expect(memberTokensOf({})).toBeUndefined();
    });
});
