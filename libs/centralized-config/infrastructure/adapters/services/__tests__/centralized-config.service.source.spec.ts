import { CentralizedConfigService } from '../centralized-config.service';

const make = (configValue: unknown, serverKey?: string) => {
    const service = Object.create(
        CentralizedConfigService.prototype,
    ) as CentralizedConfigService;
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({ configValue }),
    };
    const codeManagementService = {
        connectionServerKey: jest.fn().mockResolvedValue(serverKey),
    };
    Object.assign(service, {
        parametersService,
        codeManagementService,
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    return { service, parametersService, codeManagementService };
};

describe('CentralizedConfigService.getCentralizedSource', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

    it("names the server of the config repository's connection, reading the config once", async () => {
        const { service, parametersService, codeManagementService } = make(
            {
                repository: { id: 'cfg', name: 'kodus-config' },
                integrationId: 'gl-a',
            },
            'GITLAB|git.acme.io',
        );

        const source = await service.getCentralizedSource(orgTeam);

        expect(source).toEqual({
            repositoryId: 'cfg',
            connectionId: 'gl-a',
            serverKey: 'GITLAB|git.acme.io',
            connectionScoped: false,
        });
        expect(parametersService.findByKey).toHaveBeenCalledTimes(1);
        expect(codeManagementService.connectionServerKey).toHaveBeenCalledWith({
            ...orgTeam,
            integrationId: 'gl-a',
        });
    });

    it('leaves the server out when no connection answers', async () => {
        const { service } = make({ repository: { id: 'cfg', name: 'c' } });

        const source = await service.getCentralizedSource(orgTeam);

        expect(source.serverKey).toBeUndefined();
    });
});
