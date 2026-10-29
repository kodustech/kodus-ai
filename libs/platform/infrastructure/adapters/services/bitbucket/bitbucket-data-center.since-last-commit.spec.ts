jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { BitbucketDataCenterService } from './bitbucket-data-center.service';

const makeService = (get: jest.Mock) => {
    const service = new BitbucketDataCenterService(
        {} as any,
        {} as any,
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

const change = (path: string) => ({ path: { toString: path }, type: 'MODIFY' });

/** Pages of `compare/changes` and of the PR's changes, keyed by `start`. */
const makeGet = (
    comparePages: Record<number, unknown>,
    prPages: Record<number, unknown> = {
        0: { values: [change('zz/own.ts')], isLastPage: true },
    },
) =>
    jest.fn((url: string, config?: { params?: { start?: number } }) => {
        const start = config?.params?.start ?? 0;
        if (url.endsWith('/pull-requests/7')) {
            return Promise.resolve({
                data: { fromRef: { latestCommit: 'head-sha' } },
            });
        }
        if (url.endsWith('/compare/changes')) {
            return Promise.resolve({ data: comparePages[start] });
        }
        if (url.endsWith('/pull-requests/7/changes')) {
            return Promise.resolve({ data: prPages[start] });
        }
        return Promise.reject(new Error(`unexpected ${url}`));
    });

const read = (service: BitbucketDataCenterService) =>
    service.getChangedFilesSinceLastCommit({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 't' },
        repository: { id: 'r1', name: 'api' },
        prNumber: 7,
        lastCommit: { sha: 'reviewed-sha' },
    });

/** #2268: after the target branch is merged into the PR. */
describe('BitbucketDataCenterService.getChangedFilesSinceLastCommit', () => {
    it('reads every compare page and keeps only the PR files', async () => {
        const get = makeGet({
            0: {
                values: [change('merged/a.ts')],
                isLastPage: false,
                nextPageStart: 1,
            },
            1: {
                values: [change('merged/b.ts'), change('zz/own.ts')],
                isLastPage: true,
            },
        });
        const { service } = makeService(get);

        const files = await read(service);

        expect(files.map((f: { filename: string }) => f.filename)).toEqual([
            'zz/own.ts',
        ]);
        // From the last reviewed commit to the PR head.
        expect(get).toHaveBeenCalledWith(
            '/projects/PRJ/repos/api/compare/changes',
            {
                params: expect.objectContaining({
                    from: 'reviewed-sha',
                    to: 'head-sha',
                    start: 0,
                }),
            },
        );
    });

    it('reads every page of the PR changes', async () => {
        const get = makeGet(
            {
                0: {
                    values: [change('src/first.ts'), change('zz/own.ts')],
                    isLastPage: true,
                },
            },
            {
                0: {
                    values: [change('src/first.ts')],
                    isLastPage: false,
                    nextPageStart: 1,
                },
                1: { values: [change('zz/own.ts')], isLastPage: true },
            },
        );
        const { service } = makeService(get);

        const files = await read(service);

        expect(files.map((f: { filename: string }) => f.filename)).toEqual([
            'src/first.ts',
            'zz/own.ts',
        ]);
    });

    it('returns [] when no compared file belongs to the PR', async () => {
        const get = makeGet({
            0: { values: [change('merged/a.ts')], isLastPage: true },
        });
        const { service } = makeService(get);

        await expect(read(service)).resolves.toEqual([]);
    });

    it('returns null when the compare could not be read to its last page', async () => {
        const get = makeGet({
            0: {
                values: [change('merged/a.ts')],
                isLastPage: false,
                nextPageStart: 1,
            },
        });
        const { service, logger } = makeService(get);

        await expect(read(service)).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    reason: 'diff_incomplete',
                }),
            }),
        );
    });

    it.each([
        ['without values', { isLastPage: true }],
        ['without isLastPage', { values: [] }],
    ])(
        'returns null when a compare page comes back %s',
        async (_label, page) => {
            const { service } = makeService(makeGet({ 0: page }));

            await expect(read(service)).resolves.toBeNull();
        },
    );

    it('rethrows a 429', async () => {
        const get = jest.fn().mockRejectedValue({ response: { status: 429 } });
        const { service } = makeService(get);

        await expect(read(service)).rejects.toMatchObject({
            response: { status: 429 },
        });
    });

    it('returns null when a read fails', async () => {
        const get = jest.fn().mockRejectedValue(new Error('boom'));
        const { service } = makeService(get);

        await expect(read(service)).resolves.toBeNull();
    });
});
