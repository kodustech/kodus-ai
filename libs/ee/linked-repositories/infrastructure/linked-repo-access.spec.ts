import { PlatformType } from '@libs/core/domain/enums';
import {
    LazyLinkedRepoAccess,
    formatLinkedReposSummaryLine,
    type LinkedRepoAccessDeps,
} from './linked-repo-access';
import type {
    LinkedRepositoriesReviewMetadata,
    ResolvedLinkedRepository,
} from '../domain/linked-repository.types';

/**
 * Mutation-killing unit tests for the deterministic logic in
 * linked-repo-access.ts: buildAuthHeader (exercised via tryClone, the only
 * caller — the function itself is module-local), formatLinkedReposSummaryLine,
 * and the private index/lookup key machinery.
 */

// Minimal factory for a ResolvedLinkedRepository. Only the fields the tested
// methods actually read are meaningful; the rest carry inert defaults.
function makeRepo(
    over: Partial<ResolvedLinkedRepository> = {},
): ResolvedLinkedRepository {
    return {
        repository: 'acme/backend-api',
        fullName: 'acme/backend-api',
        id: 'repo-id-1',
        name: 'backend-api',
        instructions: undefined,
        preferredRef: 'main',
        refCandidates: [],
        defaultBranch: 'main',
        rootPath: '/sandbox/_linked/backend-api',
        status: 'pending',
        ...over,
    };
}

function makeDeps(
    over: Partial<LinkedRepoAccessDeps> = {},
): LinkedRepoAccessDeps {
    return {
        sandbox: {} as any,
        resolved: [],
        warnings: [],
        getCloneParams: async () => null,
        ...over,
    };
}

describe('buildAuthHeader (via LazyLinkedRepoAccess.tryClone)', () => {
    // tryClone builds the auth header, then passes it to sandbox.run as the
    // GIT_AUTH_HEADER env. A capturing sandbox lets us assert the exact header
    // string the deterministic buildAuthHeader produced.
    function captureHeaderSandbox() {
        const calls: Array<{ cmd: string; envs?: Record<string, string> }> = [];
        return {
            calls,
            sandbox: {
                run: async (
                    cmd: string,
                    opts: { envs?: Record<string, string> },
                ) => {
                    calls.push({ cmd, envs: opts?.envs });
                    return { exitCode: 0, stdout: '', stderr: '' };
                },
            } as any,
        };
    }

    async function headerFor(
        platform: PlatformType,
        token: string,
        username?: string,
    ): Promise<string | undefined> {
        const cap = captureHeaderSandbox();
        const access = new LazyLinkedRepoAccess(
            makeDeps({ sandbox: cap.sandbox }),
        );
        const repo = makeRepo();
        const result = await (access as any).tryClone(
            repo,
            {
                url: 'https://host/x.git',
                authToken: token,
                platform,
                authUsername: username,
            },
            'main',
        );
        expect(result).toEqual({ ok: true });
        return cap.calls[0]?.envs?.GIT_AUTH_HEADER;
    }

    it('GITHUB uses x-access-token as the basic-auth user', async () => {
        const header = await headerFor(PlatformType.GITHUB, 'ghs_secret');
        const expected =
            'Authorization: Basic ' +
            Buffer.from('x-access-token:ghs_secret').toString('base64');
        expect(header).toBe(expected);
    });

    it('GITLAB uses oauth2 as the basic-auth user', async () => {
        const header = await headerFor(PlatformType.GITLAB, 'gl_secret');
        const expected =
            'Authorization: Basic ' +
            Buffer.from('oauth2:gl_secret').toString('base64');
        expect(header).toBe(expected);
    });

    it('AZURE_REPOS uses oauth2 as the basic-auth user', async () => {
        const header = await headerFor(PlatformType.AZURE_REPOS, 'az_secret');
        const expected =
            'Authorization: Basic ' +
            Buffer.from('oauth2:az_secret').toString('base64');
        expect(header).toBe(expected);
    });

    it('unknown platform falls back to x-access-token (default branch)', async () => {
        const header = await headerFor(PlatformType.FORGEJO, 'fj_secret');
        const expected =
            'Authorization: Basic ' +
            Buffer.from('x-access-token:fj_secret').toString('base64');
        expect(header).toBe(expected);
    });

    it('BITBUCKET with an ATATT token ignores username and uses x-bitbucket-api-token-auth', async () => {
        const header = await headerFor(
            PlatformType.BITBUCKET,
            'ATATT_apitoken',
            'someuser',
        );
        const expected =
            'Authorization: Basic ' +
            Buffer.from('x-bitbucket-api-token-auth:ATATT_apitoken').toString(
                'base64',
            );
        expect(header).toBe(expected);
    });

    it('BITBUCKET with a non-ATATT token uses the provided username', async () => {
        const header = await headerFor(
            PlatformType.BITBUCKET,
            'app_password',
            'someuser',
        );
        const expected =
            'Authorization: Basic ' +
            Buffer.from('someuser:app_password').toString('base64');
        expect(header).toBe(expected);
    });

    it('BITBUCKET with a non-ATATT token and no username throws', async () => {
        const cap = captureHeaderSandbox();
        const access = new LazyLinkedRepoAccess(
            makeDeps({ sandbox: cap.sandbox }),
        );
        await expect(
            (access as any).tryClone(
                makeRepo(),
                {
                    url: 'https://host/x.git',
                    authToken: 'app_password',
                    platform: PlatformType.BITBUCKET,
                    authUsername: undefined,
                },
                'main',
            ),
        ).rejects.toThrow(
            'Bitbucket authentication requires a username or an Atlassian API token.',
        );
        // The throw happens before sandbox.run is reached.
        expect(cap.calls).toHaveLength(0);
    });

    it('boundary: "ATATT" prefix must be at the START — a token merely containing it uses the username', async () => {
        // Kills a mutation of startsWith → includes.
        const header = await headerFor(
            PlatformType.BITBUCKET,
            'xATATTy',
            'someuser',
        );
        const expected =
            'Authorization: Basic ' +
            Buffer.from('someuser:xATATTy').toString('base64');
        expect(header).toBe(expected);
    });

    it('no auth token: no GIT_AUTH_HEADER env is passed', async () => {
        const cap = captureHeaderSandbox();
        const access = new LazyLinkedRepoAccess(
            makeDeps({ sandbox: cap.sandbox }),
        );
        const result = await (access as any).tryClone(
            makeRepo(),
            {
                url: 'https://host/x.git',
                authToken: '',
                platform: PlatformType.GITHUB,
            },
            'main',
        );
        expect(result).toEqual({ ok: true });
        expect(cap.calls[0].envs).toBeUndefined();
        // Without auth the fetch command must NOT carry the extraHeader flag.
        expect(cap.calls[0].cmd).not.toContain('http.extraHeader');
    });

    it('with auth the fetch/checkout commands carry the http.extraHeader flag', async () => {
        const cap = captureHeaderSandbox();
        const access = new LazyLinkedRepoAccess(
            makeDeps({ sandbox: cap.sandbox }),
        );
        await (access as any).tryClone(
            makeRepo(),
            {
                url: 'https://host/x.git',
                authToken: 'ghs_secret',
                platform: PlatformType.GITHUB,
            },
            'main',
        );
        expect(cap.calls[0].cmd).toContain(
            'git -c http.extraHeader="$GIT_AUTH_HEADER" fetch',
        );
        expect(cap.calls[0].cmd).toContain(
            'git -c http.extraHeader="$GIT_AUTH_HEADER" checkout linked-head',
        );
    });

    it('non-zero exit returns ok:false with stderr sliced to 300 chars', async () => {
        const access = new LazyLinkedRepoAccess(
            makeDeps({
                sandbox: {
                    run: async () => ({
                        exitCode: 128,
                        stderr: 'x'.repeat(500),
                        stdout: '',
                    }),
                } as any,
            }),
        );
        const result = await (access as any).tryClone(
            makeRepo(),
            {
                url: 'https://host/x.git',
                authToken: 'ghs_secret',
                platform: PlatformType.GITHUB,
            },
            'main',
        );
        expect(result.ok).toBe(false);
        expect(result.error).toBe('x'.repeat(300));
    });
});

describe('LazyLinkedRepoAccess.index / lookup', () => {
    it('indexes fullName, repository, name, id, and last-segment keys (case-insensitive)', () => {
        const repo = makeRepo({
            fullName: 'Acme/Backend-API',
            repository: 'Acme/Backend-API',
            name: 'Backend-API',
            id: 'REPO-42',
        });
        const access = new LazyLinkedRepoAccess(makeDeps({ resolved: [repo] }));
        const lookup = (k: string) => (access as any).lookup(k);

        expect(lookup('acme/backend-api')).toBe(repo); // fullName
        expect(lookup('backend-api')).toBe(repo); // name / last segment
        expect(lookup('repo-42')).toBe(repo); // id
        expect(lookup('ACME/BACKEND-API')).toBe(repo); // upper-cased input
    });

    it('strips a trailing .git and trims whitespace before lookup', () => {
        const repo = makeRepo({ fullName: 'acme/backend-api' });
        const access = new LazyLinkedRepoAccess(makeDeps({ resolved: [repo] }));
        expect((access as any).lookup('  acme/backend-api.git  ')).toBe(repo);
    });

    it('falls back to the last path segment when the full key misses', () => {
        const repo = makeRepo({
            fullName: 'acme/backend-api',
            name: 'backend-api',
        });
        const access = new LazyLinkedRepoAccess(makeDeps({ resolved: [repo] }));
        // "other-org/backend-api" is not a stored key, but its last segment is.
        expect((access as any).lookup('other-org/backend-api')).toBe(repo);
    });

    it('returns undefined for an empty key (guard) and for an unknown key', () => {
        const repo = makeRepo({ fullName: 'acme/backend-api' });
        const access = new LazyLinkedRepoAccess(makeDeps({ resolved: [repo] }));
        expect((access as any).lookup('')).toBeUndefined();
        expect((access as any).lookup('nope/nothing')).toBeUndefined();
    });

    it('first-wins when two repos share an index key', () => {
        const first = makeRepo({
            fullName: 'org-a/shared',
            repository: 'org-a/shared',
            name: 'shared',
            id: 'id-a',
        });
        const second = makeRepo({
            fullName: 'org-b/shared',
            repository: 'org-b/shared',
            name: 'shared',
            id: 'id-b',
        });
        const access = new LazyLinkedRepoAccess(
            makeDeps({ resolved: [first, second] }),
        );
        // The shared "shared" key must resolve to the FIRST-indexed repo.
        expect((access as any).lookup('shared')).toBe(first);
        // Each repo is still reachable by its unique fullName.
        expect((access as any).lookup('org-a/shared')).toBe(first);
        expect((access as any).lookup('org-b/shared')).toBe(second);
    });
});

describe('LazyLinkedRepoAccess.list', () => {
    it('returns the exact projection shape and dedupes by fullName (case-insensitive, first-wins)', () => {
        const first = makeRepo({
            fullName: 'acme/backend-api',
            instructions: 'the API',
            preferredRef: 'develop',
            status: 'ready',
        });
        const dupe = makeRepo({
            fullName: 'ACME/Backend-API',
            instructions: 'a later duplicate',
            preferredRef: 'main',
            status: 'failed',
        });
        const other = makeRepo({
            fullName: 'acme/frontend',
            instructions: undefined,
            preferredRef: 'main',
            status: 'pending',
        });
        const access = new LazyLinkedRepoAccess(
            makeDeps({ resolved: [first, dupe, other] }),
        );
        expect(access.list()).toEqual([
            {
                repository: 'acme/backend-api',
                instructions: 'the API',
                preferredRef: 'develop',
                status: 'ready',
            },
            {
                repository: 'acme/frontend',
                instructions: undefined,
                preferredRef: 'main',
                status: 'pending',
            },
        ]);
    });
});

describe('formatLinkedReposSummaryLine', () => {
    function meta(
        repositories: LinkedRepositoriesReviewMetadata['repositories'],
    ): LinkedRepositoriesReviewMetadata {
        return {
            configured: repositories.length,
            resolved: repositories.length,
            cloned: 0,
            failed: 0,
            warnings: [],
            repositories,
        };
    }

    it('returns empty string when metadata is undefined', () => {
        expect(formatLinkedReposSummaryLine(undefined)).toBe('');
    });

    it('returns empty string when there are no repositories', () => {
        expect(formatLinkedReposSummaryLine(meta([]))).toBe('');
    });

    it('returns empty string when no repository is ready', () => {
        expect(
            formatLinkedReposSummaryLine(
                meta([
                    {
                        repository: 'acme/backend',
                        ref: 'main',
                        status: 'failed',
                    },
                    {
                        repository: 'acme/frontend',
                        ref: 'main',
                        status: 'skipped',
                    },
                ]),
            ),
        ).toBe('');
    });

    it('formats a single ready repo without a PR number', () => {
        expect(
            formatLinkedReposSummaryLine(
                meta([
                    {
                        repository: 'acme/backend',
                        ref: 'main',
                        status: 'ready',
                    },
                ]),
            ),
        ).toBe('\n\n**Additional context used:** `acme/backend@main`');
    });

    it('appends the open PR number when prNumber is set and ref does not name a PR', () => {
        expect(
            formatLinkedReposSummaryLine(
                meta([
                    {
                        repository: 'acme/backend',
                        ref: 'feature/x',
                        status: 'ready',
                        prNumber: 123,
                    },
                ]),
            ),
        ).toBe(
            '\n\n**Additional context used:** `acme/backend@feature/x` (open PR #123)',
        );
    });

    it('does NOT append the PR number when the ref already names the PR (case/space-insensitive)', () => {
        expect(
            formatLinkedReposSummaryLine(
                meta([
                    {
                        repository: 'acme/backend',
                        ref: 'open PR #123',
                        status: 'ready',
                        prNumber: 123,
                    },
                ]),
            ),
        ).toBe('\n\n**Additional context used:** `acme/backend@open PR #123`');
        // lowercase + no space between PR and # must also match the regex.
        expect(
            formatLinkedReposSummaryLine(
                meta([
                    {
                        repository: 'acme/backend',
                        ref: 'pr#5',
                        status: 'ready',
                        prNumber: 5,
                    },
                ]),
            ),
        ).toBe('\n\n**Additional context used:** `acme/backend@pr#5`');
    });

    it('falls back to "unknown" when the ref is missing', () => {
        expect(
            formatLinkedReposSummaryLine(
                meta([
                    {
                        repository: 'acme/backend',
                        ref: '',
                        status: 'ready',
                    },
                ]),
            ),
        ).toBe('\n\n**Additional context used:** `acme/backend@unknown`');
    });

    it('joins multiple ready repos with ", " and drops non-ready ones', () => {
        expect(
            formatLinkedReposSummaryLine(
                meta([
                    {
                        repository: 'acme/backend',
                        ref: 'main',
                        status: 'ready',
                    },
                    {
                        repository: 'acme/dropped',
                        ref: 'main',
                        status: 'failed',
                    },
                    {
                        repository: 'acme/frontend',
                        ref: 'develop',
                        status: 'ready',
                        prNumber: 7,
                    },
                ]),
            ),
        ).toBe(
            '\n\n**Additional context used:** `acme/backend@main`, `acme/frontend@develop` (open PR #7)',
        );
    });
});
