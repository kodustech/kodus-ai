jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { BitbucketDataCenterService } from './bitbucket-data-center.service';

const jsonDiff = (source: string | null, destination: string | null) => ({
    source: source ? { toString: source } : null,
    destination: destination ? { toString: destination } : null,
    hunks: [
        {
            sourceLine: 1,
            sourceSpan: 2,
            destinationLine: 1,
            destinationSpan: 2,
            segments: [
                { type: 'CONTEXT', lines: [{ line: 'a' }] },
                { type: 'REMOVED', lines: [{ line: 'b' }] },
                { type: 'ADDED', lines: [{ line: 'B' }] },
            ],
        },
    ],
});

const PATCH = '@@ -1,2 +1,2 @@\n a\n-b\n+B\n';

const makeService = (get: jest.Mock) => {
    const service = new BitbucketDataCenterService(
        {} as any,
        {
            findOne: jest.fn().mockResolvedValue({
                configValue: [{ id: 'r1', name: 'api', workspaceId: 'PRJ' }],
            }),
        } as any,
        {} as any,
        { get: jest.fn() } as any,
    );
    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
    jest.spyOn(service as any, 'getRepoConfig').mockResolvedValue({
        id: 'r1',
        name: 'api',
        workspaceId: 'PRJ',
    });
    jest.spyOn(service as any, 'getAxiosInstance').mockReturnValue({ get });
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (service as any).logger = logger;
    return { service, logger };
};

const org = { organizationId: 'org-1', teamId: 't' };
const repository = { id: 'r1', name: 'api' };

describe('BitbucketDataCenterService — PR diffs', () => {
    it('rebuilds a unified patch from the JSON hunks of a PR file', async () => {
        const get = jest.fn((url: string) => {
            if (url.endsWith('/pull-requests/7')) {
                return Promise.resolve({
                    data: { fromRef: { latestCommit: 'head' } },
                });
            }
            if (url.endsWith('/pull-requests/7/changes')) {
                return Promise.resolve({
                    data: {
                        values: [
                            { path: { toString: 'a.ts' }, type: 'MODIFY' },
                        ],
                    },
                });
            }
            if (url.endsWith('/pull-requests/7/diff')) {
                return Promise.resolve({
                    data: { diffs: [jsonDiff('a.ts', 'a.ts')] },
                });
            }
            return Promise.resolve({ data: 'content' });
        });
        const { service } = makeService(get);

        const files = await service.getFilesByPullRequestId({
            organizationAndTeamData: org,
            repository,
            prNumber: 7,
        });

        expect(files).toEqual([
            expect.objectContaining({
                filename: 'a.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
                changes: 2,
                patch: PATCH,
            }),
        ]);
    });

    describe('getFilesByPullRequestId without one request per file', () => {
        const changes = {
            values: ['a.ts', 'b.ts', 'c.ts'].map((path) => ({
                path: { toString: path },
                type: 'MODIFY',
            })),
        };
        const host = (wholeDiff: () => any) =>
            jest.fn((url: string, config?: any) => {
                if (url.endsWith('/pull-requests/7')) {
                    return Promise.resolve({
                        data: { fromRef: { latestCommit: 'head' } },
                    });
                }
                if (url.endsWith('/pull-requests/7/changes')) {
                    return Promise.resolve({ data: changes });
                }
                if (url.endsWith('/pull-requests/7/diff')) {
                    const path = config?.params?.path;
                    return Promise.resolve({
                        data: path
                            ? { diffs: [jsonDiff(path, path)] }
                            : wholeDiff(),
                    });
                }
                return Promise.reject(new Error(`unexpected ${url}`));
            });
        const list = (service: BitbucketDataCenterService) =>
            service.getFilesByPullRequestId({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
            });

        it('reads the whole PR diff once and no file contents', async () => {
            const get = host(() => ({
                diffs: ['a.ts', 'b.ts', 'c.ts'].map((p) => jsonDiff(p, p)),
            }));
            const { service } = makeService(get);

            const files = await list(service);

            const diffCalls = get.mock.calls.filter(([url]) =>
                url.endsWith('/diff'),
            );
            expect(diffCalls).toHaveLength(1);
            expect(diffCalls[0][1]).toBeUndefined();
            expect(get.mock.calls.some(([url]) => url.includes('/raw/'))).toBe(
                false,
            );
            expect(files?.map((f) => [f.filename, f.patch, f.content])).toEqual(
                [
                    ['a.ts', PATCH, null],
                    ['b.ts', PATCH, null],
                    ['c.ts', PATCH, null],
                ],
            );
        });

        it('reads files one by one when the host truncated the whole diff', async () => {
            const get = host(() => ({ truncated: true, diffs: [] }));
            const { service, logger } = makeService(get);

            const files = await list(service);

            const perFile = get.mock.calls
                .filter(([url, config]) => url.endsWith('/diff') && config)
                .map(([, config]) => config.params.path);
            expect(perFile.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
            expect(files?.every((f) => f.patch === PATCH)).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('truncated'),
                }),
            );
        });
    });

    describe('getFilesByPullRequestId under a rate limit', () => {
        const rateLimited = () =>
            Object.assign(new Error('Request failed with status code 429'), {
                response: { status: 429 },
            });
        const hostWith = (overrides: Record<string, () => Promise<any>>) =>
            jest.fn((url: string) => {
                for (const [suffix, answer] of Object.entries(overrides)) {
                    if (url.endsWith(suffix)) return answer();
                }
                if (url.endsWith('/pull-requests/7')) {
                    return Promise.resolve({
                        data: { fromRef: { latestCommit: 'head' } },
                    });
                }
                if (url.endsWith('/pull-requests/7/changes')) {
                    return Promise.resolve({
                        data: {
                            values: [
                                { path: { toString: 'a.ts' }, type: 'MODIFY' },
                            ],
                        },
                    });
                }
                if (url.endsWith('/pull-requests/7/diff')) {
                    return Promise.resolve({
                        data: { diffs: [jsonDiff('a.ts', 'a.ts')] },
                    });
                }
                return Promise.resolve({ data: 'content' });
            });
        const list = (service: BitbucketDataCenterService) =>
            service.getFilesByPullRequestId({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
            });

        it('lets a 429 on the file listing through instead of returning no files', async () => {
            const { service } = makeService(
                hostWith({
                    '/pull-requests/7/changes': () =>
                        Promise.reject(rateLimited()),
                }),
            );

            await expect(list(service)).rejects.toMatchObject({
                response: { status: 429 },
            });
        });

        it('lets a 429 on a per-file diff read through instead of an empty patch', async () => {
            // The whole diff comes back truncated, so the per-file reads run;
            // only those (they carry params.path) answer 429.
            const get = jest.fn((url: string, config?: any) => {
                if (url.endsWith('/pull-requests/7')) {
                    return Promise.resolve({
                        data: { fromRef: { latestCommit: 'head' } },
                    });
                }
                if (url.endsWith('/pull-requests/7/changes')) {
                    return Promise.resolve({
                        data: {
                            values: [
                                { path: { toString: 'a.ts' }, type: 'MODIFY' },
                            ],
                        },
                    });
                }
                if (url.endsWith('/pull-requests/7/diff')) {
                    return config?.params?.path
                        ? Promise.reject(rateLimited())
                        : Promise.resolve({
                              data: { truncated: true, diffs: [] },
                          });
                }
                return Promise.reject(new Error(`unexpected ${url}`));
            });
            const { service } = makeService(get);

            await expect(list(service)).rejects.toMatchObject({
                response: { status: 429 },
            });
            expect(
                get.mock.calls.some(
                    ([url, config]) =>
                        url.endsWith('/diff') &&
                        config?.params?.path === 'a.ts',
                ),
            ).toBe(true);
        });
    });

    describe('getPullRequestFilesAtCommit', () => {
        const read = (service: BitbucketDataCenterService) =>
            service.getPullRequestFilesAtCommit({
                organizationAndTeamData: org,
                repository,
                prNumber: 7,
                baseBranch: 'main',
                headSha: 'old-head',
            });

        it('compares the earlier head with the target, one patch per file', async () => {
            const get = jest.fn((url: string) =>
                url.endsWith('/pull-requests/7')
                    ? Promise.resolve({
                          data: { toRef: { latestCommit: 'main-tip' } },
                      })
                    : Promise.resolve({
                          data: {
                              diffs: [
                                  jsonDiff('a.ts', 'a.ts'),
                                  jsonDiff('old.ts', 'new.ts'),
                                  jsonDiff(null, 'added.ts'),
                              ],
                          },
                      }),
            );
            const { service } = makeService(get);

            const files = await read(service);

            expect(get).toHaveBeenCalledWith(
                '/projects/PRJ/repos/api/compare/diff',
                { params: { from: 'old-head', to: 'main-tip' } },
            );
            expect(files).toEqual([
                expect.objectContaining({
                    filename: 'a.ts',
                    status: 'modified',
                    patch: PATCH,
                    additions: 1,
                    deletions: 1,
                }),
                expect.objectContaining({
                    filename: 'new.ts',
                    previous_filename: 'old.ts',
                    status: 'renamed',
                }),
                expect.objectContaining({
                    filename: 'added.ts',
                    status: 'added',
                }),
            ]);
        });

        it('returns null when the host cut the diff short', async () => {
            const get = jest.fn((url: string) =>
                url.endsWith('/pull-requests/7')
                    ? Promise.resolve({
                          data: { toRef: { latestCommit: 'main-tip' } },
                      })
                    : Promise.resolve({
                          data: { truncated: true, diffs: [] },
                      }),
            );
            const { service, logger } = makeService(get);

            await expect(read(service)).resolves.toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        reason: 'compare_truncated',
                    }),
                }),
            );
        });

        it('lets a rate limit through, so the review is not rerun in full', async () => {
            const { service } = makeService(
                jest.fn().mockRejectedValue(
                    Object.assign(new Error('Too Many Requests'), {
                        status: 429,
                    }),
                ),
            );

            await expect(read(service)).rejects.toMatchObject({ status: 429 });
        });

        it('returns null and warns when the earlier head cannot be read', async () => {
            const { service, logger } = makeService(
                jest.fn().mockRejectedValue(new Error('404')),
            );

            await expect(read(service)).resolves.toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        headSha: 'old-head',
                        reason: 'compare_failed',
                    }),
                }),
            );
        });
    });
});
