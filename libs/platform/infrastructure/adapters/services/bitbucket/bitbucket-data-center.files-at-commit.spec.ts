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
                        values: [{ path: { toString: 'a.ts' }, type: 'MODIFY' }],
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
