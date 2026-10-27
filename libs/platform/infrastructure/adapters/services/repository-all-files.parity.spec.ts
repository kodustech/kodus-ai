jest.mock(
    '../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

const forgejoGetTree = jest.fn();
jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    getTree: (...args: unknown[]) => forgejoGetTree(...args),
}));

import { AGENT_INSTRUCTION_FILE_DISCOVERY_PATTERNS } from '@libs/common/utils/kody-rules/file-patterns';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from './bitbucket/bitbucket-data-center.service';
import { ForgejoService } from './forgejo.service';
import { GithubService } from './github/github.service';
import { GitlabService } from './gitlab.service';
import { RepositoryListingError } from './repository-listing';

/**
 * Every git host lists a repository the same way for the callers that look
 * for coding-agent instruction files (the review and onboarding): nested files
 * included, each once, from the repository's default branch when none is
 * given, and, when asked, a failure that is not mistaken for an empty
 * repository.
 */

const TREE = [
    'AGENTS.md',
    'CLAUDE.md',
    'apps/billing/CLAUDE.md',
    'libs/x/AGENTS.md',
    'packages/ui/claude.md',
    '.cursor/rules/style.mdc',
    'apps/web/.cursor/rules/nested/ui.mdc',
    '.github/copilot-instructions.md',
    '.github/instructions/api.instructions.md',
    'src/index.ts',
    'docs/NOT-AGENTS.md.bak',
    '.cursor/rules/readme.txt',
    'README.md',
];

const INSTRUCTION_FILES = TREE.slice(0, 9);
const DEFAULT_BRANCH = 'develop';
const PAGE_SIZE = 3;

type Fake = { noAuth?: boolean; failWith?: Error };
type Made = { service: any; refs: string[] };

const quiet = (service: any) =>
    Object.defineProperty(service, 'logger', {
        value: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

const dirsOf = (paths: string[]) => {
    const dirs = new Set<string>();
    for (const p of paths) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'));
        }
    }
    return [...dirs];
};

const HOSTS: Array<{ name: string; make: (fake: Fake) => Made }> = [
    {
        name: 'GitHub',
        make: ({ noAuth, failWith }) => {
            const refs: string[] = [];
            const service = quiet(Object.create(GithubService.prototype));
            jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue(
                noAuth ? null : {},
            );
            jest.spyOn(service, 'getCorrectOwner').mockResolvedValue('acme');
            jest.spyOn(service, 'getDefaultBranch').mockResolvedValue(
                DEFAULT_BRANCH,
            );
            const getTree = jest.fn(async ({ tree_sha }) => {
                refs.push(tree_sha);
                if (failWith) throw failWith;
                return {
                    data: {
                        tree: [
                            ...dirsOf(TREE).map((path) => ({
                                path,
                                type: 'tree',
                            })),
                            ...TREE.map((path) => ({ path, type: 'blob' })),
                        ],
                    },
                };
            });
            jest.spyOn(service, 'instanceOctokit').mockResolvedValue({
                rest: { git: { getTree } },
            });
            return { service, refs };
        },
    },
    {
        name: 'GitLab',
        make: ({ noAuth, failWith }) => {
            const refs: string[] = [];
            const service = quiet(Object.create(GitlabService.prototype));
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue(
                noAuth ? null : {},
            );
            jest.spyOn(service, 'getDefaultBranch').mockResolvedValue(
                DEFAULT_BRANCH,
            );
            // The tree API as GitLab answers it: the direct children of
            // `path`, or everything under it with `recursive`.
            const allRepositoryTrees = jest.fn(
                async (
                    _id: string,
                    opts: { ref: string; path?: string; recursive?: boolean },
                ) => {
                    refs.push(opts.ref);
                    if (failWith) throw failWith;
                    const base = opts.path ? `${opts.path}/` : '';
                    const entries = [
                        ...dirsOf(TREE).map((path) => ({ path, type: 'tree' })),
                        ...TREE.map((path) => ({ path, type: 'blob' })),
                    ];
                    return entries.filter((e) => {
                        if (!e.path.startsWith(base)) return false;
                        const rest = e.path.slice(base.length);
                        return opts.recursive || !rest.includes('/');
                    });
                },
            );
            jest.spyOn(service, 'instanceGitlabApi').mockReturnValue({
                Repositories: { allRepositoryTrees },
            });
            return { service, refs };
        },
    },
    {
        name: 'Bitbucket Cloud',
        make: ({ noAuth, failWith }) => {
            const refs: string[] = [];
            const service = quiet(
                Object.create(BitbucketCloudService.prototype),
            );
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue(
                noAuth ? null : {},
            );
            jest.spyOn(service, 'getWorkspaceFromRepository').mockResolvedValue(
                'ws',
            );
            jest.spyOn(service, 'getDefaultBranch').mockResolvedValue(
                DEFAULT_BRANCH,
            );
            const entries = [
                ...dirsOf(TREE).map((path) => ({
                    path,
                    type: 'commit_directory',
                })),
                ...TREE.map((path) => ({ path, type: 'commit_file' })),
            ];
            const page = (n: number) => ({
                values: entries.slice(n * PAGE_SIZE, (n + 1) * PAGE_SIZE),
                page: n,
                next:
                    (n + 1) * PAGE_SIZE < entries.length
                        ? `next-${n + 1}`
                        : undefined,
            });
            jest.spyOn(service, 'instanceBitbucketApi').mockReturnValue({
                commits: {
                    list: jest.fn(async ({ include }) => {
                        refs.push(include);
                        return { data: { values: [{ hash: 'abc' }] } };
                    }),
                },
                source: {
                    read: jest.fn(async () => {
                        if (failWith) throw failWith;
                        return { data: page(0) };
                    }),
                },
                hasNextPage: (data: { next?: string }) => !!data.next,
                getNextPage: async (data: { page: number }) => ({
                    data: page(data.page + 1),
                }),
            });
            return { service, refs };
        },
    },
    {
        name: 'Bitbucket Data Center',
        make: ({ noAuth, failWith }) => {
            const refs: string[] = [];
            const service = quiet(
                Object.create(BitbucketDataCenterService.prototype),
            );
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue(
                noAuth ? null : {},
            );
            jest.spyOn(service, 'getRepoConfig').mockResolvedValue({
                id: 'r1',
                name: 'api',
                workspaceId: 'PRJ',
            });
            jest.spyOn(service, 'getDefaultBranch').mockResolvedValue(
                DEFAULT_BRANCH,
            );
            jest.spyOn(service, 'getAxiosInstance').mockReturnValue({
                get: jest.fn(async (_url: string, { params }) => {
                    refs.push(params.at);
                    if (failWith) throw failWith;
                    return { data: { values: TREE } };
                }),
            });
            return { service, refs };
        },
    },
    {
        name: 'Azure Repos',
        make: ({ noAuth, failWith }) => {
            const refs: string[] = [];
            const service = quiet(Object.create(AzureReposService.prototype));
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue(
                noAuth ? null : { orgName: 'acme', token: 't' },
            );
            jest.spyOn(service, 'getProjectIdFromRepository').mockResolvedValue(
                'p1',
            );
            jest.spyOn(service, 'getDefaultBranch').mockResolvedValue(
                DEFAULT_BRANCH,
            );
            Object.defineProperty(service, 'azureReposRequestHelper', {
                value: {
                    listRepositoryFiles: jest.fn(async ({ filters }) => {
                        refs.push(filters.branch);
                        if (failWith) throw failWith;
                        return [
                            ...dirsOf(TREE).map((p) => ({
                                path: `/${p}`,
                                isFolder: true,
                                gitObjectType: 'tree',
                            })),
                            ...TREE.map((p) => ({
                                path: `/${p}`,
                                isFolder: false,
                                gitObjectType: 'blob',
                            })),
                        ];
                    }),
                },
            });
            return { service, refs };
        },
    },
    {
        name: 'Forgejo',
        make: ({ noAuth, failWith }) => {
            const refs: string[] = [];
            const service = quiet(Object.create(ForgejoService.prototype));
            jest.spyOn(service, 'getAuthDetails').mockResolvedValue(
                noAuth ? null : { host: 'https://forgejo.example', token: 't' },
            );
            jest.spyOn(service, 'createForgejoClient').mockReturnValue({});
            jest.spyOn(service, 'getDefaultBranch').mockResolvedValue(
                DEFAULT_BRANCH,
            );
            const entries = [
                ...dirsOf(TREE).map((path) => ({ path, type: 'tree' })),
                ...TREE.map((path) => ({ path, type: 'blob' })),
            ];
            // Forgejo pages a recursive tree and flags `truncated` while
            // entries remain.
            forgejoGetTree
                .mockReset()
                .mockImplementation(async ({ path, query, throwOnError }) => {
                    refs.push(path.sha);
                    // The client answers a failed request with `error`, and
                    // throws only when asked to.
                    if (failWith && throwOnError) throw failWith;
                    if (failWith)
                        return { error: { message: failWith.message } };
                    const pageNumber = query?.page ?? 1;
                    const start = (pageNumber - 1) * PAGE_SIZE;
                    return {
                        data: {
                            tree: entries.slice(start, start + PAGE_SIZE),
                            truncated: start + PAGE_SIZE < entries.length,
                            page: pageNumber,
                            total_count: entries.length,
                        },
                    };
                });
            return { service, refs };
        },
    },
];

const list = (
    service: any,
    filters: Record<string, unknown>,
    throwOnError?: boolean,
): Promise<{ path: string }[]> =>
    service.getRepositoryAllFiles({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'r1', name: 'acme/api' },
        filters,
        ...(throwOnError ? { throwOnError } : {}),
    });

const paths = (files: { path: string }[]) =>
    files.map((f) => f.path.replace(/^\/+/, ''));

describe.each(HOSTS)('$name getRepositoryAllFiles', ({ make }) => {
    it('finds every coding-agent instruction file, nested ones included, each once', async () => {
        const { service } = make({});

        const found = paths(
            await list(service, {
                branch: 'main',
                filePatterns: [...AGENT_INSTRUCTION_FILE_DISCOVERY_PATTERNS],
            }),
        );

        expect([...found].sort()).toEqual([...INSTRUCTION_FILES].sort());
    });

    it('lists a file two patterns cover once', async () => {
        const { service } = make({});

        const found = paths(
            await list(service, {
                branch: 'main',
                filePatterns: [
                    '.github/copilot-instructions.md',
                    '.github/**/*.md',
                    '.github/instructions/**/*.instructions.md',
                    'AGENTS.md',
                ],
            }),
        );

        expect([...found].sort()).toEqual([
            '.github/copilot-instructions.md',
            '.github/instructions/api.instructions.md',
            'AGENTS.md',
        ]);
    });

    it('leaves out paths an exclude pattern matches', async () => {
        const { service } = make({});

        const found = paths(
            await list(service, {
                branch: 'main',
                filePatterns: ['**/CLAUDE.md'],
                excludePatterns: ['apps/**'],
            }),
        );

        expect([...found].sort()).toEqual([
            'CLAUDE.md',
            'packages/ui/claude.md',
        ]);
    });

    it("lists the repository's default branch when no branch is given", async () => {
        const { service, refs } = make({});

        await list(service, {
            filePatterns: [...AGENT_INSTRUCTION_FILE_DISCOVERY_PATTERNS],
        });

        expect(refs.length).toBeGreaterThan(0);
        expect(new Set(refs)).toEqual(new Set([DEFAULT_BRANCH]));
    });

    it('returns [] on a host failure unless asked to throw', async () => {
        const { service } = make({ failWith: new Error('502 Bad Gateway') });

        await expect(
            list(service, { branch: 'main', filePatterns: ['**/*.md'] }),
        ).resolves.toEqual([]);
    });

    it('throws a RepositoryListingError on a host failure when asked', async () => {
        const { service } = make({ failWith: new Error('502 Bad Gateway') });

        await expect(
            list(service, { branch: 'main', filePatterns: ['**/*.md'] }, true),
        ).rejects.toBeInstanceOf(RepositoryListingError);
    });

    it('throws a RepositoryListingError without credentials when asked', async () => {
        const { service } = make({ noAuth: true });

        await expect(
            list(service, { branch: 'main', filePatterns: ['**/*.md'] }, true),
        ).rejects.toBeInstanceOf(RepositoryListingError);
    });
});
