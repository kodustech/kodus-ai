import { BitbucketDataCenterService } from './bitbucket-data-center.service';

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

/** The service without its constructor: only what a test hands it. */
const make = (overrides: Record<string, unknown>) => {
    const service = Object.create(BitbucketDataCenterService.prototype) as any;
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    for (const [key, value] of Object.entries({ logger, ...overrides })) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

describe('BitbucketDataCenterService.userCanWrite', () => {
    const params = {
        organizationAndTeamData,
        repository: { id: '42' },
        login: 'dev',
    };
    const build = (get: jest.Mock) =>
        make({
            getAuthDetails: jest.fn().mockResolvedValue({ host: 'h' }),
            getAxiosInstance: () => ({ get }),
        });

    it('asks for users with an effective REPO_WRITE on the repository', async () => {
        const get = jest.fn().mockResolvedValue({
            data: { values: [{ name: 'dev' }], isLastPage: true },
        });

        expect(await build(get).userCanWrite(params)).toBe(true);
        expect(get).toHaveBeenCalledWith('/users', {
            params: expect.objectContaining({
                'filter': 'dev',
                'permission.1': 'REPO_WRITE',
                'permission.1.repositoryId': '42',
            }),
        });
    });

    it('pages past users whose name only contains the login', async () => {
        const get = jest
            .fn()
            .mockResolvedValueOnce({
                data: {
                    values: [{ name: 'dev-bot' }],
                    isLastPage: false,
                    nextPageStart: 100,
                },
            })
            .mockResolvedValueOnce({
                data: { values: [{ slug: 'dev' }], isLastPage: true },
            });

        expect(await build(get).userCanWrite(params)).toBe(true);
        expect(get.mock.calls[1][1].params.start).toBe(100);
    });

    it('cannot write when no user with write matches', async () => {
        const get = jest.fn().mockResolvedValue({
            data: { values: [{ name: 'dev-bot' }], isLastPage: true },
        });

        expect(await build(get).userCanWrite(params)).toBe(false);
    });

    it('cannot say when the read fails', async () => {
        const get = jest.fn().mockRejectedValue(new Error('401'));

        expect(await build(get).userCanWrite(params)).toBeUndefined();
    });
});

describe('BitbucketDataCenterService.getListMembers', () => {
    const build = (get: jest.Mock) =>
        make({
            getAuthDetails: jest.fn().mockResolvedValue({ host: 'h' }),
            getAxiosInstance: () => ({ get }),
            integrationConfigService: {
                findOne: jest.fn().mockResolvedValue({
                    configValue: [
                        { workspaceId: 'A', name: 'one' },
                        { workspaceId: 'B', name: 'two' },
                    ],
                }),
            },
        });
    const get = () =>
        jest.fn(async (path: string) => {
            if (path.startsWith('/projects/B')) throw new Error('403');
            return {
                data: {
                    values: [{ user: { name: 'dev', displayName: 'Dev' } }],
                    isLastPage: true,
                },
            };
        });

    it('keeps the projects it read when one fails', async () => {
        expect(
            await build(get()).getListMembers({ organizationAndTeamData }),
        ).toEqual([expect.objectContaining({ id: 'dev' })]);
    });

    it('throws a partial list when asked for a complete one', async () => {
        await expect(
            build(get()).getListMembers({
                organizationAndTeamData,
                requireComplete: true,
            }),
        ).rejects.toThrow('403');
    });
});
