import { GetConnectionsUseCase } from '../get-connections.use-case';

const ORG = 'org-1';
const TEAM = 'team-1';

const build = (
    connections: Array<Record<string, unknown>>,
    licences: {
        primaryConnectionId: string | null;
        ownLicenceConnectionIds: string[];
    } | null = { primaryConnectionId: null, ownLicenceConnectionIds: [] },
) => {
    const codeManagementService = {
        verifyConnection: jest.fn(async (params: any) => ({
            platformName: connections.find(
                (c) => c.uuid === params.organizationAndTeamData.integrationId,
            )?.platform,
            category: 'CODE_MANAGEMENT',
            hasConnection: true,
        })),
    };
    const integrationService = {
        find: jest.fn().mockResolvedValue(connections),
    };
    const licenseService = {
        getConnectionLicenses: jest.fn().mockResolvedValue(licences),
    };
    const useCase = new GetConnectionsUseCase(
        codeManagementService as any,
        { user: { organization: { uuid: ORG } } } as any,
        integrationService as any,
        licenseService as any,
    );
    return {
        useCase,
        codeManagementService,
        integrationService,
        licenseService,
    };
};

describe('GetConnectionsUseCase', () => {
    it('lists every Git connection of the workspace, each checked on its own', async () => {
        const { useCase, codeManagementService } = build([
            {
                uuid: 'gh-a',
                platform: 'GITHUB',
                name: 'Acme',
                reviewEnabled: true,
            },
            {
                uuid: 'gl-b',
                platform: 'GITLAB',
                name: null,
                reviewEnabled: false,
            },
        ]);

        const result = await useCase.execute(TEAM);

        expect(codeManagementService.verifyConnection).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: ORG,
                teamId: TEAM,
                integrationId: 'gh-a',
            },
        });
        expect(result).toEqual([
            expect.objectContaining({
                platformName: 'GITHUB',
                connectionId: 'gh-a',
                connectionName: 'Acme',
                reviewEnabled: true,
            }),
            expect.objectContaining({
                platformName: 'GITLAB',
                connectionId: 'gl-b',
                connectionName: null,
                reviewEnabled: false,
            }),
        ]);
    });

    it('returns nothing for a workspace with no connection, asking billing nothing', async () => {
        const { useCase, licenseService } = build([]);

        await expect(useCase.execute(TEAM)).resolves.toEqual([]);
        expect(licenseService.getConnectionLicenses).not.toHaveBeenCalled();
    });

    it('says which connections bill on a subscription of their own, so a reset can warn first', async () => {
        const rows = [
            { uuid: 'gh-a', platform: 'GITHUB' },
            { uuid: 'gl-b', platform: 'GITLAB' },
        ];
        const { useCase, licenseService } = build(rows, {
            primaryConnectionId: 'gh-a',
            ownLicenceConnectionIds: ['gl-b'],
        });

        const result = await useCase.execute(TEAM);

        expect(licenseService.getConnectionLicenses).toHaveBeenCalledWith({
            organizationId: ORG,
            teamId: TEAM,
        });
        expect(
            result.map(({ connectionId, ownSubscription }) => ({
                connectionId,
                ownSubscription,
            })),
        ).toEqual([
            { connectionId: 'gh-a', ownSubscription: false },
            { connectionId: 'gl-b', ownSubscription: true },
        ]);
    });

    it('checks at most four connections at a time, keeping each answer', async () => {
        const rows = Array.from({ length: 9 }, (_, i) => ({
            uuid: `conn-${i}`,
            platform: 'GITHUB',
        }));
        const { useCase, codeManagementService } = build(rows);
        let inFlight = 0;
        let peak = 0;
        codeManagementService.verifyConnection.mockImplementation(
            async (params: any) => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight -= 1;
                if (params.organizationAndTeamData.integrationId === 'conn-3') {
                    throw new Error('provider down');
                }
                return { category: 'CODE_MANAGEMENT', hasConnection: true };
            },
        );

        const result = await useCase.execute(TEAM);

        expect(peak).toBe(4);
        expect(result.map(({ connectionId }) => connectionId)).toEqual(
            rows.map(({ uuid }) => uuid).filter((uuid) => uuid !== 'conn-3'),
        );
    });

    it('says it could not tell when billing cannot be read', async () => {
        const { useCase } = build([{ uuid: 'gh-a', platform: 'GITHUB' }], null);

        const [only] = await useCase.execute(TEAM);

        expect(only.ownSubscription).toBeNull();
    });
});
