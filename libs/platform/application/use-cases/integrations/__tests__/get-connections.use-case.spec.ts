import { GetConnectionsUseCase } from '../get-connections.use-case';

const ORG = 'org-1';
const TEAM = 'team-1';

const build = (connections: Array<Record<string, unknown>>) => {
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
    const useCase = new GetConnectionsUseCase(
        codeManagementService as any,
        { user: { organization: { uuid: ORG } } } as any,
        integrationService as any,
    );
    return { useCase, codeManagementService, integrationService };
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

    it('returns nothing for a workspace with no connection', async () => {
        const { useCase } = build([]);

        await expect(useCase.execute(TEAM)).resolves.toEqual([]);
    });
});
