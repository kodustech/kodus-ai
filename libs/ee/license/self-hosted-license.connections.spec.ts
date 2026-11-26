import { SelfHostedLicenseService } from './self-hosted-license.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

type Entry = {
    gitId: string;
    status: 'active' | 'inactive';
    provider?: string;
    connectionId?: string;
};

const github = {
    organizationId: 'org-1',
    teamId: 'team-1',
    integrationId: 'gh-a',
};
const gitlab = {
    organizationId: 'org-1',
    teamId: 'team-1',
    integrationId: 'gl-b',
};

const build = (users: Entry[], seats = 10) => {
    const store: { users: Entry[] } = { users };
    const orgParams = {
        findByKey: jest.fn(async () => ({
            configValue: { users: store.users },
        })),
        find: jest.fn(async () => [{ configValue: { users: store.users } }]),
        createOrUpdateConfig: jest.fn(
            async (_key: unknown, value: { users: Entry[] }) => {
                store.users = value.users;
            },
        ),
    };
    const service = new SelfHostedLicenseService(orgParams as any);
    jest.spyOn(service, 'validateOrganizationLicense').mockResolvedValue({
        valid: true,
        numberOfLicenses: seats,
    });
    return { service, store };
};

describe('SelfHostedLicenseService per Git connection', () => {
    it('records the provider and connection of a new seat', async () => {
        const { service, store } = build([]);

        await expect(
            service.assignLicense(gitlab, '7', 'GITLAB'),
        ).resolves.toBe(true);

        expect(store.users).toEqual([
            {
                gitId: '7',
                status: 'active',
                provider: 'gitlab',
                connectionId: 'gl-b',
            },
        ]);
    });

    it('gives a GitLab user a seat of their own even when a GitHub user holds the same id', async () => {
        const { service, store } = build([
            {
                gitId: '7',
                status: 'active',
                provider: 'github',
                connectionId: 'gh-a',
            },
        ]);

        await service.assignLicense(gitlab, '7', 'gitlab');

        expect(store.users).toHaveLength(2);
    });

    it("lists only the named connection's seats, plus seats from before connections were recorded", async () => {
        const { service } = build([
            {
                gitId: '1',
                status: 'active',
                provider: 'github',
                connectionId: 'gh-a',
            },
            {
                gitId: '2',
                status: 'active',
                provider: 'gitlab',
                connectionId: 'gl-b',
            },
            { gitId: '3', status: 'active' },
        ]);

        const seats = await service.getAllUsersWithLicense(gitlab);

        expect(seats.map((s) => s.git_id).sort()).toEqual(['2', '3']);
        expect(seats.find((s) => s.git_id === '3')).toMatchObject({
            sharedAcrossConnections: true,
        });
        expect(
            seats.find((s) => s.git_id === '2')?.sharedAcrossConnections,
        ).toBeUndefined();
    });

    it('releases a seat on the named connection only', async () => {
        const { service, store } = build([
            {
                gitId: '7',
                status: 'active',
                provider: 'github',
                connectionId: 'gh-a',
            },
            {
                gitId: '7',
                status: 'active',
                provider: 'gitlab',
                connectionId: 'gl-b',
            },
        ]);

        await service.unassignLicenses(gitlab, ['7']);

        expect(store.users).toEqual([
            expect.objectContaining({ connectionId: 'gh-a', status: 'active' }),
            expect.objectContaining({
                connectionId: 'gl-b',
                status: 'inactive',
            }),
        ]);
    });

    it('counts one instance seat per provider identity', async () => {
        const { service } = build(
            [
                {
                    gitId: '7',
                    status: 'active',
                    provider: 'github',
                    connectionId: 'gh-a',
                },
                {
                    gitId: '7',
                    status: 'active',
                    provider: 'github',
                    connectionId: 'gh-c',
                },
            ],
            2,
        );

        await expect(
            service.assignLicense(gitlab, '7', 'gitlab'),
        ).resolves.toBe(true);
        await expect(
            service.assignLicense(github, '8', 'github'),
        ).resolves.toBe(false);
    });

    it('keeps an org with no connection recorded working as before', async () => {
        const { service, store } = build([{ gitId: '7', status: 'inactive' }]);

        await service.assignLicense(
            { organizationId: 'org-1', teamId: 'team-1' },
            '7',
            'github',
        );

        expect(store.users).toEqual([{ gitId: '7', status: 'active' }]);
    });

    it('attributes seats from before connections to the connection that held them, so a second connection never shares them', async () => {
        const { service, store } = build([
            { gitId: '3', status: 'active' },
            { gitId: '4', status: 'inactive' },
            {
                gitId: '5',
                status: 'active',
                provider: 'github',
                connectionId: 'gh-a',
            },
        ]);

        await service.attributeLegacySeats(gitlab, {
            uuid: 'gl-b',
            platform: 'GITLAB',
        });

        expect(store.users).toEqual([
            {
                gitId: '3',
                status: 'active',
                provider: 'gitlab',
                connectionId: 'gl-b',
            },
            {
                gitId: '4',
                status: 'inactive',
                provider: 'gitlab',
                connectionId: 'gl-b',
            },
            {
                gitId: '5',
                status: 'active',
                provider: 'github',
                connectionId: 'gh-a',
            },
        ]);

        const forgejo = { ...gitlab, integrationId: 'fj-c' };
        await expect(service.getAllUsersWithLicense(forgejo)).resolves.toEqual(
            [],
        );
    });

    it('writes nothing when every seat already names its connection', async () => {
        const { service } = build([
            {
                gitId: '5',
                status: 'active',
                provider: 'github',
                connectionId: 'gh-a',
            },
        ]);
        const write = jest.spyOn(
            (service as any).organizationParametersService,
            'createOrUpdateConfig',
        );

        await service.attributeLegacySeats(github, {
            uuid: 'gh-a',
            platform: 'GITHUB',
        });

        expect(write).not.toHaveBeenCalled();
    });

    it('counts a seat from before connections once with any seat of the same git id, as before', async () => {
        const { service } = build(
            [
                { gitId: '7', status: 'active' },
                {
                    gitId: '7',
                    status: 'active',
                    provider: 'github',
                    connectionId: 'gh-a',
                },
            ],
            2,
        );

        await expect(
            service.assignLicense(github, '8', 'github'),
        ).resolves.toBe(true);
    });
});
