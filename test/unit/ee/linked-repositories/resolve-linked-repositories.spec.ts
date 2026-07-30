import {
    resolveLinkedRepositories,
    linkedRepoRootPath,
    slugifyRepo,
    prHeadRefspecForPlatform,
} from '@libs/ee/linked-repositories';
import { MAX_LINKED_REPOSITORIES } from '@libs/ee/linked-repositories';

describe('resolveLinkedRepositories', () => {
    const connected = [
        {
            id: '1',
            name: 'backend-api',
            full_name: 'org/backend-api',
            default_branch: 'main',
        },
        {
            id: '2',
            name: 'frontend',
            full_name: 'org/frontend',
            default_branch: 'develop',
        },
        {
            id: '3',
            name: 'shared-lib',
            full_name: 'org/shared-lib',
            default_branch: 'main',
        },
        {
            id: '4',
            name: 'billing',
            full_name: 'org/billing',
            default_branch: 'main',
        },
    ];

    it('returns empty when config is absent', () => {
        const result = resolveLinkedRepositories({
            configured: undefined,
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
        });
        expect(result.resolved).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it('builds cascade: head-branch → default → main/master when no pin', () => {
        const result = resolveLinkedRepositories({
            configured: [
                {
                    repository: 'org/backend-api',
                    instructions: 'REST API',
                },
            ],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
            prHeadBranch: 'feature/x',
        });
        expect(result.resolved).toHaveLength(1);
        const repo = result.resolved[0];
        expect(repo.fullName).toBe('org/backend-api');
        expect(repo.preferredRef).toBe('feature/x');
        // default_branch is "main", so the main fallback is deduped by fetchRef.
        expect(repo.refCandidates.map((c) => c.source)).toEqual([
            'head-branch',
            'default',
            'fallback', // master only — main already covered by default
        ]);
        expect(repo.refCandidates[0]).toMatchObject({
            fetchRef: 'feature/x',
            source: 'head-branch',
        });
        expect(repo.instructions).toBe('REST API');
        expect(repo.rootPath).toBe('/home/user/_linked/org_backend-api');
        expect(result.warnings).toEqual([]);
    });

    it('honors config ref pin above head branch', () => {
        const result = resolveLinkedRepositories({
            configured: [{ repository: 'org/backend-api', ref: 'release-1' }],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
            prHeadBranch: 'feature/x',
        });
        expect(result.resolved[0].preferredRef).toBe('release-1');
        expect(result.resolved[0].refCandidates[0]).toMatchObject({
            fetchRef: 'release-1',
            source: 'config-pin',
        });
        // Head branch remains as a later candidate.
        expect(
            result.resolved[0].refCandidates.some(
                (c) => c.source === 'head-branch',
            ),
        ).toBe(true);
    });

    it('prefers PR-description #N override over config pin', () => {
        const result = resolveLinkedRepositories({
            configured: [{ repository: 'org/backend-api', ref: 'main' }],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
            prHeadBranch: 'feature/x',
            prDescription:
                'Coordinated change — see org/backend-api#42 for the API side.',
        });
        expect(result.resolved[0].refCandidates[0]).toMatchObject({
            source: 'pr-description',
            prNumber: 42,
            displayRef: 'open PR #42',
            fetchRef: 'refs/pull/42/head',
        });
        expect(result.resolved[0].preferredRef).toBe('open PR #42');
    });

    it('prefers PR-description @branch override', () => {
        const result = resolveLinkedRepositories({
            configured: [{ repository: 'org/backend-api' }],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
            prHeadBranch: 'feature/x',
            prDescription: 'Use org/backend-api@release/2.0',
        });
        expect(result.resolved[0].refCandidates[0]).toMatchObject({
            source: 'pr-description',
            fetchRef: 'release/2.0',
            displayRef: 'release/2.0',
        });
    });

    it('uses resolved description PR head SHA when provided', () => {
        const descriptionPrHeads = new Map([
            [
                'org/backend-api',
                {
                    prNumber: 42,
                    headRef: 'feature/api-change',
                    headSha: 'abc123deadbeef',
                },
            ],
        ]);
        const result = resolveLinkedRepositories({
            configured: [{ repository: 'org/backend-api' }],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
            prDescription: 'org/backend-api#42',
            descriptionPrHeads,
        });
        expect(result.resolved[0].refCandidates[0]).toMatchObject({
            source: 'pr-description',
            fetchRef: 'abc123deadbeef',
            displayRef: 'open PR #42',
            prNumber: 42,
        });
    });

    it('prefers open PR on matching head branch over bare branch', () => {
        const openPrOnHeadBranch = new Map([
            [
                'org/backend-api',
                {
                    prNumber: 77,
                    headRef: 'feature/x',
                    headSha: 'sha77',
                },
            ],
        ]);
        const result = resolveLinkedRepositories({
            configured: [{ repository: 'org/backend-api' }],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
            prHeadBranch: 'feature/x',
            openPrOnHeadBranch,
        });
        expect(result.resolved[0].refCandidates[0]).toMatchObject({
            source: 'open-pr',
            fetchRef: 'sha77',
            displayRef: 'open PR #77',
            prNumber: 77,
        });
        // Bare branch name is still in the cascade (as open-pr's headRef
        // fallback and/or head-branch). fetchRef dedupe collapses duplicates.
        expect(
            result.resolved[0].refCandidates.some(
                (c) => c.fetchRef === 'feature/x',
            ),
        ).toBe(true);
    });

    it('ignores description overrides for non-linked repos with a warning', () => {
        const result = resolveLinkedRepositories({
            configured: [{ repository: 'org/backend-api' }],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
            prDescription: 'Also look at evil/other-org#9',
        });
        expect(result.resolved).toHaveLength(1);
        expect(
            result.warnings.some((w) =>
                w.includes('evil/other-org') && w.includes('not in linkedRepositories'),
            ),
        ).toBe(true);
    });

    it('drops repos not connected to the org with a visible warning', () => {
        const result = resolveLinkedRepositories({
            configured: [
                { repository: 'org/backend-api' },
                { repository: 'evil/other-org' },
            ],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
        });
        expect(result.resolved).toHaveLength(1);
        expect(result.resolved[0].fullName).toBe('org/backend-api');
        expect(result.warnings).toEqual(
            expect.arrayContaining([
                expect.stringContaining('evil/other-org'),
            ]),
        );
    });

    it('soft-caps at MAX_LINKED_REPOSITORIES with warnings for excess', () => {
        const result = resolveLinkedRepositories({
            configured: [
                { repository: 'org/backend-api' },
                { repository: 'org/frontend' },
                { repository: 'org/shared-lib' },
                { repository: 'org/billing' },
            ],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
        });
        expect(result.resolved).toHaveLength(MAX_LINKED_REPOSITORIES);
        expect(result.warnings.some((w) => w.includes('capped'))).toBe(true);
    });

    it('drops malformed entries with a warning', () => {
        const result = resolveLinkedRepositories({
            configured: [
                { repository: '' } as any,
                { repository: 'org/backend-api' },
            ],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
        });
        expect(result.resolved).toHaveLength(1);
        expect(result.warnings.some((w) => w.includes('missing'))).toBe(true);
    });

    it('dedupes duplicate fullNames', () => {
        const result = resolveLinkedRepositories({
            configured: [
                { repository: 'org/backend-api' },
                { repository: 'backend-api' },
            ],
            connectedRepositories: connected,
            sandboxRepoDir: '/home/user/repo',
        });
        expect(result.resolved).toHaveLength(1);
        expect(result.warnings.some((w) => w.includes('duplicate'))).toBe(
            true,
        );
    });

    it('nests _linked under local sandbox repoDir (not sibling of temp)', () => {
        expect(linkedRepoRootPath('/tmp/kodus-sandbox-abc', 'x')).toBe(
            '/tmp/kodus-sandbox-abc/_linked/x',
        );
        expect(linkedRepoRootPath('/home/user/repo', 'x')).toBe(
            '/home/user/_linked/x',
        );
    });

    it('slugifyRepo sanitizes path segments', () => {
        expect(slugifyRepo('org/my repo!')).toBe('org_my_repo');
        expect(slugifyRepo('org/backend-api')).toBe('org_backend-api');
    });

    it('prHeadRefspecForPlatform is provider-aware', () => {
        expect(prHeadRefspecForPlatform('github', 3).fetchRef).toBe(
            'refs/pull/3/head',
        );
        expect(prHeadRefspecForPlatform('gitlab', 3).fetchRef).toBe(
            'refs/merge-requests/3/head',
        );
    });
});
