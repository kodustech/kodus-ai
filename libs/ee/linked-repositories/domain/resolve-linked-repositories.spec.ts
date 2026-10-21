import {
    resolveLinkedRepositories,
    prHeadRefspecForPlatform,
    slugifyRepo,
    linkedRepoRootPath,
    type ConnectedRepository,
    type ResolveLinkedRepositoriesInput,
} from './resolve-linked-repositories';
import {
    LinkedRepositoryConfig,
    MAX_LINKED_REPOSITORIES,
} from './linked-repository.types';

/**
 * Mutation-killing tests for the deterministic linked-repository resolver.
 *
 * The private helpers (buildRefCandidates, defaultGithubPrRefspec,
 * buildConnectedIndex, findConnected, normalizeFullName) are not exported, so
 * they are exercised through resolveLinkedRepositories and asserted via the
 * exact shape of its output (refCandidates, fullName, id, name, etc.).
 */

// Base input factory — every field explicitly present so tests toggle one axis.
function baseInput(
    overrides: Partial<ResolveLinkedRepositoriesInput> = {},
): ResolveLinkedRepositoriesInput {
    return {
        configured: [],
        connectedRepositories: [],
        sandboxRepoDir: '/home/user/repo',
        ...overrides,
    };
}

const connectedApi: ConnectedRepository = {
    id: '10',
    name: 'api',
    full_name: 'org/api',
    default_branch: 'develop',
};

describe('resolveLinkedRepositories — early guards', () => {
    it('returns empty resolved with no warnings when configured is undefined', () => {
        const res = resolveLinkedRepositories(
            baseInput({ configured: undefined }),
        );
        expect(res.resolved).toEqual([]);
        expect(res.warnings).toEqual([]);
        expect(res.descriptionOverrides.size).toBe(0);
    });

    it('returns empty resolved when configured is an empty array', () => {
        const res = resolveLinkedRepositories(baseInput({ configured: [] }));
        expect(res.resolved).toEqual([]);
        expect(res.warnings).toEqual([]);
    });

    it('still parses description overrides even when nothing is configured', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [],
                prDescription: 'context in org/api#42',
            }),
        );
        // Overrides are parsed regardless; but with no configured repos the
        // "not in linkedRepositories" warning loop is skipped (early return).
        expect(res.descriptionOverrides.get('org/api')).toEqual({
            kind: 'pr',
            repository: 'org/api',
            prNumber: 42,
        });
        expect(res.warnings).toEqual([]);
    });
});

describe('resolveLinkedRepositories — entry validation', () => {
    it('drops an entry with a missing/blank repository field', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: '   ' } as LinkedRepositoryConfig],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved).toEqual([]);
        expect(res.warnings).toContain(
            'linkedRepositories entry missing required "repository" field; dropped.',
        );
    });

    it('drops an entry whose repository is not a string', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [
                    { repository: 123 } as unknown as LinkedRepositoryConfig,
                ],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved).toEqual([]);
        expect(res.warnings).toContain(
            'linkedRepositories entry missing required "repository" field; dropped.',
        );
    });

    it('drops a repository that is not connected to the organization', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/ghost' }],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved).toEqual([]);
        expect(res.warnings).toContain(
            'linkedRepositories: "org/ghost" is not connected to this organization; dropped.',
        );
    });

    it('drops a duplicate that resolves to the same connected repo', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [
                    { repository: 'org/api' },
                    { repository: 'ORG/API' }, // same repo, different casing
                ],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved).toHaveLength(1);
        expect(res.warnings).toContain(
            'linkedRepositories: duplicate "org/api" ignored.',
        );
    });
});

describe('resolveLinkedRepositories — cap enforcement', () => {
    it('caps at the provided maxLinked and names the dropped entry', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                maxLinked: 1,
                configured: [
                    { repository: 'org/api' },
                    { repository: 'org/web' },
                ],
                connectedRepositories: [
                    connectedApi,
                    { id: '11', name: 'web', full_name: 'org/web' },
                ],
            }),
        );
        expect(res.resolved).toHaveLength(1);
        expect(res.resolved[0].fullName).toBe('org/api');
        expect(res.warnings).toContain(
            'linkedRepositories capped at 1; dropped "org/web".',
        );
    });

    it('does not cap at the boundary — exactly maxLinked entries all resolve', () => {
        // Kills `>=` -> `>` and off-by-one boundary mutants: with maxLinked=2
        // and 2 valid entries, both must resolve and no cap warning fires.
        const res = resolveLinkedRepositories(
            baseInput({
                maxLinked: 2,
                configured: [
                    { repository: 'org/api' },
                    { repository: 'org/web' },
                ],
                connectedRepositories: [
                    connectedApi,
                    { id: '11', name: 'web', full_name: 'org/web' },
                ],
            }),
        );
        expect(res.resolved).toHaveLength(2);
        expect(res.warnings.some((w) => w.includes('capped'))).toBe(false);
    });

    it('defaults the cap to MAX_LINKED_REPOSITORIES', () => {
        const configured: LinkedRepositoryConfig[] = [
            { repository: 'org/a' },
            { repository: 'org/b' },
            { repository: 'org/c' },
            { repository: 'org/d' },
        ];
        const connected: ConnectedRepository[] = [
            { id: '1', name: 'a', full_name: 'org/a' },
            { id: '2', name: 'b', full_name: 'org/b' },
            { id: '3', name: 'c', full_name: 'org/c' },
            { id: '4', name: 'd', full_name: 'org/d' },
        ];
        const res = resolveLinkedRepositories(
            baseInput({ configured, connectedRepositories: connected }),
        );
        expect(MAX_LINKED_REPOSITORIES).toBe(3);
        expect(res.resolved).toHaveLength(3);
        expect(res.warnings).toContain(
            `linkedRepositories capped at ${MAX_LINKED_REPOSITORIES}; dropped "org/d".`,
        );
    });
});

describe('resolveLinkedRepositories — connected matching (findConnected/buildConnectedIndex)', () => {
    it('matches case-insensitively by full_name and strips a .git suffix', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'ORG/API.git' }],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved).toHaveLength(1);
        expect(res.resolved[0].fullName).toBe('org/api');
        expect(res.resolved[0].repository).toBe('ORG/API.git');
    });

    it('matches by the repository id', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: '10' }],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved).toHaveLength(1);
        expect(res.resolved[0].id).toBe('10');
        expect(res.resolved[0].fullName).toBe('org/api');
    });

    it('falls back to the trailing name segment when the full path misses', () => {
        // key 'someorg/api' is not indexed, but the short 'api' (the repo name)
        // is — exercises findConnected's split('/').pop() fallback.
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'someorg/api' }],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved).toHaveLength(1);
        expect(res.resolved[0].fullName).toBe('org/api');
    });

    it('skips null entries in connectedRepositories without throwing', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [
                    null as unknown as ConnectedRepository,
                    connectedApi,
                ],
            }),
        );
        expect(res.resolved).toHaveLength(1);
        expect(res.resolved[0].fullName).toBe('org/api');
    });

    it('treats an undefined connected list as empty (drops everything)', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories:
                    undefined as unknown as ConnectedRepository[],
            }),
        );
        expect(res.resolved).toEqual([]);
        expect(res.warnings).toContain(
            'linkedRepositories: "org/api" is not connected to this organization; dropped.',
        );
    });
});

describe('resolveLinkedRepositories — normalizeFullName and resolved shape', () => {
    it('derives fullName from full_name (trimmed, .git-stripped)', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [
                    { id: '9', name: 'api', full_name: '  org/api.git  ' },
                ],
            }),
        );
        expect(res.resolved[0].fullName).toBe('org/api');
    });

    it('falls back to name when full_name is blank, and derives name field', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'api' }],
                connectedRepositories: [
                    { id: '5', name: 'api', full_name: '   ' },
                ],
            }),
        );
        expect(res.resolved[0].fullName).toBe('api');
        expect(res.resolved[0].name).toBe('api');
    });

    it('derives name from the fullName tail when connected name is blank', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [
                    { id: '5', name: '', full_name: 'org/api' },
                ],
            }),
        );
        // match.name '' is falsy -> fullName.split('/').pop() -> 'api'
        expect(res.resolved[0].name).toBe('api');
    });

    it('produces the full resolved object with status pending', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                sandboxRepoDir: '/home/user/repo',
                configured: [
                    {
                        repository: 'org/api',
                        instructions: '  consumer API  ',
                        ref: '  v1.2  ',
                    },
                ],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved[0]).toEqual({
            repository: 'org/api',
            fullName: 'org/api',
            id: '10',
            name: 'api',
            instructions: 'consumer API',
            preferredRef: 'v1.2',
            defaultBranch: 'develop',
            rootPath: '/home/user/_linked/org_api',
            status: 'pending',
            refCandidates: [
                { fetchRef: 'v1.2', displayRef: 'v1.2', source: 'config-pin' },
                {
                    fetchRef: 'develop',
                    displayRef: 'develop',
                    source: 'default',
                },
                { fetchRef: 'main', displayRef: 'main', source: 'fallback' },
                {
                    fetchRef: 'master',
                    displayRef: 'master',
                    source: 'fallback',
                },
            ],
        });
    });

    it('drops blank instructions and a whitespace-only ref to undefined', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [
                    { repository: 'org/api', instructions: '   ', ref: '   ' },
                ],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved[0].instructions).toBeUndefined();
        // No config-pin candidate because ref trimmed to empty.
        expect(
            res.resolved[0].refCandidates.some(
                (c) => c.source === 'config-pin',
            ),
        ).toBe(false);
    });
});

describe('resolveLinkedRepositories — defaultBranch resolution', () => {
    it('uses the connected default_branch when present', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
            }),
        );
        expect(res.resolved[0].defaultBranch).toBe('develop');
    });

    it('falls back to "main" when default_branch is missing', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [
                    { id: '10', name: 'api', full_name: 'org/api' },
                ],
            }),
        );
        expect(res.resolved[0].defaultBranch).toBe('main');
    });

    it('falls back to "main" when default_branch is whitespace-only', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [
                    {
                        id: '10',
                        name: 'api',
                        full_name: 'org/api',
                        default_branch: '   ',
                    },
                ],
            }),
        );
        expect(res.resolved[0].defaultBranch).toBe('main');
    });
});

describe('resolveLinkedRepositories — ref cascade order (buildRefCandidates)', () => {
    it('orders description-PR override, config pin, head branch, default, fallbacks', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api', ref: 'v1.2' }],
                connectedRepositories: [connectedApi],
                prDescription: 'ships with org/api#42',
                prHeadBranch: '  feature/x  ',
            }),
        );
        expect(res.resolved[0].refCandidates).toEqual([
            {
                fetchRef: 'refs/pull/42/head',
                displayRef: 'open PR #42',
                source: 'pr-description',
                prNumber: 42,
            },
            { fetchRef: 'v1.2', displayRef: 'v1.2', source: 'config-pin' },
            {
                fetchRef: 'feature/x',
                displayRef: 'feature/x',
                source: 'head-branch',
            },
            { fetchRef: 'develop', displayRef: 'develop', source: 'default' },
            { fetchRef: 'main', displayRef: 'main', source: 'fallback' },
            { fetchRef: 'master', displayRef: 'master', source: 'fallback' },
        ]);
        // preferredRef is the first candidate's displayRef.
        expect(res.resolved[0].preferredRef).toBe('open PR #42');
    });

    it('uses a custom resolvePrHeadRefspec for description PR overrides', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
                prDescription: 'org/api#7',
                resolvePrHeadRefspec: (n) => ({
                    fetchRef: `refs/merge-requests/${n}/head`,
                    displayRef: `MR !${n}`,
                }),
            }),
        );
        expect(res.resolved[0].refCandidates[0]).toEqual({
            fetchRef: 'refs/merge-requests/7/head',
            displayRef: 'MR !7',
            source: 'pr-description',
            prNumber: 7,
        });
    });

    it('prefers the resolved head SHA and also keeps the head ref for a description PR', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
                prDescription: 'org/api#42',
                descriptionPrHeads: new Map([
                    [
                        'org/api',
                        {
                            prNumber: 42,
                            headRef: 'refs/heads/feat',
                            headSha: 'abc123',
                        },
                    ],
                ]),
            }),
        );
        const [first, second] = res.resolved[0].refCandidates;
        expect(first).toEqual({
            fetchRef: 'abc123',
            displayRef: 'open PR #42',
            source: 'pr-description',
            prNumber: 42,
        });
        expect(second).toEqual({
            fetchRef: 'refs/heads/feat',
            displayRef: 'open PR #42',
            source: 'pr-description',
            prNumber: 42,
        });
    });

    it('emits only one description-PR candidate when there is no head SHA', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
                prDescription: 'org/api#42',
                descriptionPrHeads: new Map([
                    ['org/api', { prNumber: 42, headRef: 'refs/heads/feat' }],
                ]),
            }),
        );
        const prCandidates = res.resolved[0].refCandidates.filter(
            (c) => c.source === 'pr-description',
        );
        expect(prCandidates).toEqual([
            {
                fetchRef: 'refs/heads/feat',
                displayRef: 'open PR #42',
                source: 'pr-description',
                prNumber: 42,
            },
        ]);
    });

    it('handles a branch override (owner/repo@branch) as pr-description source without prNumber', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
                prDescription: 'pin org/api@release/2.0 please',
            }),
        );
        expect(res.resolved[0].refCandidates[0]).toEqual({
            fetchRef: 'release/2.0',
            displayRef: 'release/2.0',
            source: 'pr-description',
        });
    });

    it('expands an open PR on the head branch into SHA then head-ref candidates', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
                openPrOnHeadBranch: new Map([
                    [
                        'org/api',
                        {
                            prNumber: 7,
                            headRef: 'refs/heads/foo',
                            headSha: 'sha7',
                        },
                    ],
                ]),
            }),
        );
        expect(res.resolved[0].refCandidates).toEqual([
            {
                fetchRef: 'sha7',
                displayRef: 'open PR #7',
                source: 'open-pr',
                prNumber: 7,
            },
            {
                fetchRef: 'refs/heads/foo',
                displayRef: 'open PR #7',
                source: 'open-pr',
                prNumber: 7,
            },
            { fetchRef: 'develop', displayRef: 'develop', source: 'default' },
            { fetchRef: 'main', displayRef: 'main', source: 'fallback' },
            { fetchRef: 'master', displayRef: 'master', source: 'fallback' },
        ]);
    });

    it('dedupes the default branch against the fallback list (main collision)', () => {
        // default_branch resolves to 'main', which collides with the 'main'
        // fallback — the fallback must be dropped, leaving default then master.
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [
                    { id: '10', name: 'api', full_name: 'org/api' },
                ],
            }),
        );
        expect(res.resolved[0].refCandidates).toEqual([
            { fetchRef: 'main', displayRef: 'main', source: 'default' },
            { fetchRef: 'master', displayRef: 'master', source: 'fallback' },
        ]);
    });
});

describe('resolveLinkedRepositories — unmatched description overrides', () => {
    it('warns when a description override does not match any linked repo', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
                prDescription: 'unrelated org/ghost#9',
            }),
        );
        expect(res.warnings).toContain(
            'PR description references "org/ghost" but it is not in linkedRepositories; override ignored.',
        );
    });

    it('does not warn when the override matches a linked repo', () => {
        const res = resolveLinkedRepositories(
            baseInput({
                configured: [{ repository: 'org/api' }],
                connectedRepositories: [connectedApi],
                prDescription: 'org/api#42',
            }),
        );
        expect(res.warnings.some((w) => w.includes('override ignored'))).toBe(
            false,
        );
    });
});

describe('prHeadRefspecForPlatform', () => {
    it('returns the GitLab merge-request refspec for gitlab platforms', () => {
        expect(prHeadRefspecForPlatform('gitlab', 123)).toEqual({
            fetchRef: 'refs/merge-requests/123/head',
            displayRef: 'open PR #123',
        });
    });

    it('matches gitlab case-insensitively and as a substring', () => {
        expect(prHeadRefspecForPlatform('Self-Hosted-GitLab', 5).fetchRef).toBe(
            'refs/merge-requests/5/head',
        );
    });

    it('returns the GitHub pull refspec for github platforms', () => {
        expect(prHeadRefspecForPlatform('github', 8)).toEqual({
            fetchRef: 'refs/pull/8/head',
            displayRef: 'open PR #8',
        });
    });

    it('defaults to the pull refspec when platform is undefined', () => {
        expect(prHeadRefspecForPlatform(undefined, 8)).toEqual({
            fetchRef: 'refs/pull/8/head',
            displayRef: 'open PR #8',
        });
    });
});

describe('slugifyRepo', () => {
    it('replaces the path separator with an underscore', () => {
        expect(slugifyRepo('owner/repo')).toBe('owner_repo');
    });

    it('strips a trailing .git suffix', () => {
        expect(slugifyRepo('owner/repo.git')).toBe('owner_repo');
    });

    it('does not strip .git when it is not at the very end', () => {
        expect(slugifyRepo('owner/repo.github')).toBe('owner_repo.github');
    });

    it('preserves dots, dashes and underscores', () => {
        expect(slugifyRepo('a.b-c_d')).toBe('a.b-c_d');
    });

    it('collapses runs of illegal chars and trims leading/trailing underscores', () => {
        expect(slugifyRepo('///owner///repo///')).toBe('owner_repo');
    });

    it('returns the "repo" default when the slug collapses to empty', () => {
        expect(slugifyRepo('///')).toBe('repo');
    });

    it('truncates to 80 characters', () => {
        const slug = slugifyRepo('a'.repeat(85));
        expect(slug).toBe('a'.repeat(80));
        expect(slug).toHaveLength(80);
    });
});

describe('linkedRepoRootPath', () => {
    it('rewrites the E2B /repo layout to a sibling /_linked directory', () => {
        expect(linkedRepoRootPath('/home/user/repo', 'org_api')).toBe(
            '/home/user/_linked/org_api',
        );
    });

    it('nests under the repo dir for a non-E2B (local temp) layout', () => {
        expect(linkedRepoRootPath('/tmp/xyz', 'org_api')).toBe(
            '/tmp/xyz/_linked/org_api',
        );
    });

    it('strips trailing slashes before detecting the E2B layout', () => {
        expect(linkedRepoRootPath('/home/user/repo/', 'org_api')).toBe(
            '/home/user/_linked/org_api',
        );
    });

    it('does not treat a dir merely ending in "repo" (no slash) as E2B', () => {
        // 'myrepo' must NOT match /\/repo$/ — kills a mutant dropping the slash.
        expect(linkedRepoRootPath('/home/user/myrepo', 'org_api')).toBe(
            '/home/user/myrepo/_linked/org_api',
        );
    });
});
