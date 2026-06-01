/**
 * Cache behavior tests for GithubService read methods that hit the
 * `gh:*` cache namespace introduced in commit b7606bb5c.
 *
 * We instantiate the real GithubService and stub out
 *   - getGithubAuthDetails (auth lookup)
 *   - instanceOctokit (Octokit creation)
 * so the only thing we exercise is the cache key path + the optional
 * `headSha` bypass.
 *
 * Three methods covered:
 *   1. getDefaultBranch                 (cache key: {org, repoId})
 *   2. getFilesByPullRequestId          (opt-in: {org, repoId, prNum, headSha})
 *   3. getCommitsForPullRequestForCodeReview (opt-in, same shape)
 */

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
    getObservability: () => ({
        getContext: () => ({}),
    }),
}));

import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { CacheService } from '@libs/core/cache/cache.service';

type MockOctokit = {
    repos: { get: jest.Mock; getContent: jest.Mock };
    rest: { pulls: { listFiles: jest.Mock } };
    pulls: { listCommits: jest.Mock };
    paginate: jest.Mock;
};

function makeMockCache(): CacheService {
    const store = new Map<string, { value: string; expiresAt: number }>();
    const now = () => Date.now();
    return {
        getFromCache: jest.fn(async <T,>(key: string | number) => {
            const k = String(key);
            const entry = store.get(k);
            if (!entry || entry.expiresAt < now()) {
                store.delete(k);
                return null;
            }
            return JSON.parse(entry.value) as T;
        }),
        addToCache: jest.fn(
            async <T,>(key: string | number, item: T, ttl = 60000) => {
                store.set(String(key), {
                    value: JSON.stringify(item),
                    expiresAt: now() + ttl,
                });
            },
        ),
        removeFromCache: jest.fn(async (key: string | number) => {
            store.delete(String(key));
        }),
        clearCache: jest.fn(async () => {
            store.clear();
        }),
        cacheExists: jest.fn(async (key: string | number) =>
            store.has(String(key)),
        ),
        getMultipleFromCache: jest.fn(),
        deleteByKeyPattern: jest.fn(async () => {
            store.clear();
        }),
    } as unknown as CacheService;
}

function makeService(): {
    service: GithubService;
    cache: CacheService;
    octokit: MockOctokit;
} {
    const cache = makeMockCache();
    const service = new GithubService(
        {} as any, // integrationService
        {} as any, // authIntegrationService
        {} as any, // integrationConfigService
        cache,
        {} as any, // configService
    );

    const octokit: MockOctokit = {
        repos: { get: jest.fn(), getContent: jest.fn() },
        rest: { pulls: { listFiles: jest.fn() } },
        pulls: { listCommits: jest.fn() },
        paginate: jest.fn(),
    };

    // Bypass the auth + octokit creation paths — these touch DB / network
    jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
        org: 'quintoandar',
    });
    jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(
        octokit as any,
    );

    return { service, cache, octokit };
}

describe('GithubService — cache layer (commit b7606bb5c)', () => {
    describe('getDefaultBranch', () => {
        const params = {
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't1' },
            repository: { id: 'repo-1', name: 'backend-services' },
        };

        it('hits GitHub on first call, returns the default branch', async () => {
            const { service, octokit } = makeService();
            octokit.repos.get.mockResolvedValue({
                data: { default_branch: 'main' },
            });

            const result = await service.getDefaultBranch(params);

            expect(result).toBe('main');
            expect(octokit.repos.get).toHaveBeenCalledTimes(1);
            expect(octokit.repos.get).toHaveBeenCalledWith({
                owner: 'quintoandar',
                repo: 'backend-services',
            });
        });

        it('serves from cache on the second call (no GitHub call)', async () => {
            const { service, octokit } = makeService();
            octokit.repos.get.mockResolvedValue({
                data: { default_branch: 'main' },
            });

            const first = await service.getDefaultBranch(params);
            const second = await service.getDefaultBranch(params);

            expect(first).toBe('main');
            expect(second).toBe('main');
            expect(octokit.repos.get).toHaveBeenCalledTimes(1);
        });

        it('uses repository.id in the cache key (different repos do not collide)', async () => {
            const { service, octokit } = makeService();
            octokit.repos.get
                .mockResolvedValueOnce({ data: { default_branch: 'main' } })
                .mockResolvedValueOnce({ data: { default_branch: 'develop' } });

            const a = await service.getDefaultBranch(params);
            const b = await service.getDefaultBranch({
                ...params,
                repository: { id: 'repo-2', name: 'other-repo' },
            });

            expect(a).toBe('main');
            expect(b).toBe('develop');
            expect(octokit.repos.get).toHaveBeenCalledTimes(2);
        });

        it('does NOT poison the cache when default_branch is missing', async () => {
            const { service, cache, octokit } = makeService();
            octokit.repos.get.mockResolvedValue({ data: {} });

            const result = await service.getDefaultBranch(params);

            expect(result).toBeUndefined();
            expect(cache.addToCache).not.toHaveBeenCalled();
        });
    });

    describe('getFilesByPullRequestId', () => {
        const baseParams = {
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't1' },
            repository: { id: 'repo-1', name: 'backend-services' },
            prNumber: 26306,
        };

        const fakeFiles = [
            {
                filename: 'src/a.ts',
                sha: 'file-sha-1',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: '@@ ...',
            },
        ];

        it('with headSha: hits GitHub once, then serves from cache', async () => {
            const { service, octokit } = makeService();
            octokit.paginate.mockResolvedValue(fakeFiles);

            const first = await service.getFilesByPullRequestId({
                ...baseParams,
                headSha: 'sha-abc',
            });
            const second = await service.getFilesByPullRequestId({
                ...baseParams,
                headSha: 'sha-abc',
            });

            expect(first).toHaveLength(1);
            expect(first[0].filename).toBe('src/a.ts');
            expect(second).toEqual(first);
            expect(octokit.paginate).toHaveBeenCalledTimes(1);
        });

        it('different headSha → different cache key → second call hits GitHub again', async () => {
            const { service, octokit } = makeService();
            octokit.paginate
                .mockResolvedValueOnce(fakeFiles)
                .mockResolvedValueOnce([
                    { ...fakeFiles[0], filename: 'src/b.ts' },
                ]);

            const first = await service.getFilesByPullRequestId({
                ...baseParams,
                headSha: 'sha-old',
            });
            const second = await service.getFilesByPullRequestId({
                ...baseParams,
                headSha: 'sha-new',
            });

            expect(first[0].filename).toBe('src/a.ts');
            expect(second[0].filename).toBe('src/b.ts');
            expect(octokit.paginate).toHaveBeenCalledTimes(2);
        });

        it('without headSha: cache is bypassed (legacy callers unchanged)', async () => {
            const { service, cache, octokit } = makeService();
            octokit.paginate.mockResolvedValue(fakeFiles);

            await service.getFilesByPullRequestId(baseParams);
            await service.getFilesByPullRequestId(baseParams);

            expect(octokit.paginate).toHaveBeenCalledTimes(2);
            expect(cache.addToCache).not.toHaveBeenCalled();
        });

        it('does not cache an empty file list (avoids serving stale empty after PR sync)', async () => {
            const { service, cache, octokit } = makeService();
            octokit.paginate.mockResolvedValue([]);

            await service.getFilesByPullRequestId({
                ...baseParams,
                headSha: 'sha-abc',
            });

            expect(cache.addToCache).not.toHaveBeenCalled();
        });
    });

    describe('getCommitsForPullRequestForCodeReview', () => {
        const baseParams = {
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't1' },
            repository: { id: 'repo-1', name: 'backend-services' },
            prNumber: 26306,
        };

        const fakeCommits = [
            {
                sha: 'commit-1',
                commit: {
                    author: {
                        name: 'Dev',
                        email: 'dev@example.com',
                        date: '2026-05-13T10:00:00Z',
                    },
                    message: 'feat: x',
                },
                author: { id: 1, login: 'dev' },
                parents: [{ sha: 'parent-1' }],
            },
        ];

        it('with headSha: hits GitHub once, then serves from cache', async () => {
            const { service, octokit } = makeService();
            octokit.paginate.mockResolvedValue(fakeCommits);

            const first = await service.getCommitsForPullRequestForCodeReview({
                ...baseParams,
                headSha: 'sha-abc',
            });
            const second = await service.getCommitsForPullRequestForCodeReview(
                {
                    ...baseParams,
                    headSha: 'sha-abc',
                },
            );

            expect(first).toHaveLength(1);
            expect(first?.[0].sha).toBe('commit-1');
            expect(second).toEqual(first);
            expect(octokit.paginate).toHaveBeenCalledTimes(1);
        });

        it('without headSha: cache is bypassed', async () => {
            const { service, cache, octokit } = makeService();
            octokit.paginate.mockResolvedValue(fakeCommits);

            await service.getCommitsForPullRequestForCodeReview(baseParams);
            await service.getCommitsForPullRequestForCodeReview(baseParams);

            expect(octokit.paginate).toHaveBeenCalledTimes(2);
            expect(cache.addToCache).not.toHaveBeenCalled();
        });
    });

    // Cache for the hot path during code review: per-file content fetch.
    // Key uses blob SHA so a file's content change auto-invalidates without
    // waiting for TTL — same key never points to mismatched content.
    describe('getRepositoryContentFile', () => {
        const ORG = { organizationId: 'org-1', teamId: 't1' };
        const REPO = { name: 'backend-services', id: 'repo-1' };
        const PR = {
            number: 42,
            head: { ref: 'feature/x' },
            base: { ref: 'main' },
        };

        const fileWithSha = {
            filename: 'src/App.tsx',
            sha: 'blob-abc-123',
            status: 'modified',
        };

        const fakeContentResponse = {
            data: {
                content: 'Y29udGVudA==',
                encoding: 'base64',
                sha: 'blob-abc-123',
            },
        };

        it('hits GitHub on cache miss and caches the response', async () => {
            const { service, cache, octokit } = makeService();
            octokit.repos.getContent.mockResolvedValue(fakeContentResponse);

            const result = await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: fileWithSha,
                pullRequest: PR,
            });

            expect(result).toEqual(fakeContentResponse);
            expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
            expect(cache.addToCache).toHaveBeenCalledWith(
                expect.stringContaining(`:${fileWithSha.sha}:`),
                fakeContentResponse,
                24 * 60 * 60 * 1000,
            );
        });

        it('serves from cache on the second call with the same blob sha', async () => {
            const { service, octokit } = makeService();
            octokit.repos.getContent.mockResolvedValue(fakeContentResponse);

            const first = await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: fileWithSha,
                pullRequest: PR,
            });
            const second = await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: fileWithSha,
                pullRequest: PR,
            });

            expect(first).toEqual(fakeContentResponse);
            expect(second).toEqual(fakeContentResponse);
            expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
        });

        it('different blob shas do NOT collide (file changed in new commit)', async () => {
            const { service, octokit } = makeService();
            octokit.repos.getContent
                .mockResolvedValueOnce({
                    data: { content: 'old', encoding: 'utf-8' },
                })
                .mockResolvedValueOnce({
                    data: { content: 'new', encoding: 'utf-8' },
                });

            const v1 = await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: { ...fileWithSha, sha: 'sha-v1' },
                pullRequest: PR,
            });
            const v2 = await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: { ...fileWithSha, sha: 'sha-v2' },
                pullRequest: PR,
            });

            expect((v1.data as any).content).toBe('old');
            expect((v2.data as any).content).toBe('new');
            expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
        });

        // Defensive — files without sha go straight to GitHub on every
        // call. Better a fresh fetch than a wrong-cached value.
        it('skips cache entirely when file.sha is missing', async () => {
            const { service, cache, octokit } = makeService();
            octokit.repos.getContent.mockResolvedValue(fakeContentResponse);

            await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: { filename: 'src/x.ts', sha: '', status: 'modified' },
                pullRequest: PR,
            });
            await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: { filename: 'src/x.ts', sha: '', status: 'modified' },
                pullRequest: PR,
            });

            expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
            expect(cache.addToCache).not.toHaveBeenCalled();
            expect(cache.getFromCache).not.toHaveBeenCalled();
        });

        // The fallback path (head ref deleted → base ref) intentionally
        // does NOT cache: the returned content belongs to the base ref
        // but we'd be keying it by the head's blob sha — guaranteed wrong.
        it('does NOT cache the base-ref fallback when head ref is missing', async () => {
            const { service, cache, octokit } = makeService();
            const headError = Object.assign(
                new Error('No commit found for the ref feature/x'),
                { status: 404 },
            );
            octokit.repos.getContent
                .mockRejectedValueOnce(headError)
                .mockResolvedValueOnce({
                    data: { content: 'base-content', encoding: 'utf-8' },
                });

            const result = await service.getRepositoryContentFile({
                organizationAndTeamData: ORG,
                repository: REPO,
                file: fileWithSha,
                pullRequest: PR,
            });

            expect((result.data as any).content).toBe('base-content');
            // Two octokit calls (head failed, base succeeded). Cache must
            // NOT have been populated.
            expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
            const addCalls = (cache.addToCache as jest.Mock).mock.calls;
            const wroteContentCache = addCalls.some((c) =>
                String(c[0]).startsWith('gh:contents:'),
            );
            expect(wroteContentCache).toBe(false);
        });
    });
});
