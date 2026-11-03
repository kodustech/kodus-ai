import { BitbucketCloudService } from './bitbucket-cloud.service';

/** #2268: a failed incremental read falls back to a fuller review, so a
 *  rate limit has to surface instead of reading as a failed read. */
describe('BitbucketCloudService.getChangedFilesSinceLastCommit — errors', () => {
    const makeService = (getRepoById: jest.Mock) => {
        const service = Object.create(
            BitbucketCloudService.prototype,
        ) as BitbucketCloudService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
        jest.spyOn(service as any, 'getRepoById').mockImplementation(
            getRepoById,
        );
        jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({});
        return service;
    };

    const read = (service: BitbucketCloudService) =>
        service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: 'r1', name: 'api' },
            prNumber: 7,
            lastCommit: { sha: 'reviewed-sha' },
        });

    it('rethrows a 429', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue({ status: 429 }),
        );

        await expect(read(service)).rejects.toMatchObject({ status: 429 });
    });

    it('returns null for any other failure', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue(new Error('boom')),
        );

        await expect(read(service)).resolves.toBeNull();
    });
});

/** #2268: the PR's diffstat decides which files are reviewed, so a list cut
 *  short has to read as unreadable, not as a PR with fewer files. */
describe('BitbucketCloudService.getChangedFilesSinceLastCommit — diffstat pages', () => {
    const stat = (path: string) => ({
        status: 'modified',
        lines_added: 1,
        lines_removed: 1,
        new: { path },
    });

    const makeService = (pages: Record<string, unknown>) => {
        const service = Object.create(
            BitbucketCloudService.prototype,
        ) as BitbucketCloudService;
        const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
        Object.defineProperty(service, 'logger', { value: logger });
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
        jest.spyOn(service as any, 'getRepoById').mockResolvedValue({
            id: 'r1',
            workspaceId: 'ws',
        });
        jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
            pullrequests: {
                get: jest.fn().mockResolvedValue({
                    data: { source: { commit: { hash: 'head-sha' } } },
                }),
                getDiffStat: jest.fn().mockResolvedValue({ data: pages.first }),
            },
            hasNextPage: (page: { next?: string }) => !!page?.next,
            getNextPage: async (page: { next: string }) => ({
                data: pages[page.next],
            }),
            commits: {
                getDiff: jest
                    .fn()
                    .mockResolvedValue({ data: '@@ -1 +1 @@\n-a\n+b' }),
            },
            source: { read: jest.fn().mockResolvedValue({ data: 'b' }) },
        });
        return { service, logger };
    };

    const read = (service: BitbucketCloudService) =>
        service.getChangedFilesSinceLastCommit({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
            repository: { id: 'r1', name: 'api' },
            prNumber: 7,
            lastCommit: { sha: 'reviewed-sha' },
        });

    it('reads every diffstat page', async () => {
        const { service } = makeService({
            first: { values: [stat('src/a.ts')], next: 'p2' },
            p2: { values: [stat('zz/own.ts')] },
        });

        const files = await read(service);

        expect(files?.map((f) => f.filename)).toEqual([
            'src/a.ts',
            'zz/own.ts',
        ]);
    });

    it('returns null when the first diffstat page has no values', async () => {
        const { service, logger } = makeService({ first: {} });

        await expect(read(service)).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    reason: 'diff_incomplete',
                }),
            }),
        );
    });

    it('returns null when a later diffstat page has no values', async () => {
        const { service } = makeService({
            first: { values: [stat('src/a.ts')], next: 'p2' },
            p2: {},
        });

        await expect(read(service)).resolves.toBeNull();
    });
});
