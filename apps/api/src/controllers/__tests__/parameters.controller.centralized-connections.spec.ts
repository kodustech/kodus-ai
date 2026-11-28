import { ParametersController } from '../parameters.controller';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

/**
 * The web's "Sync now" and download name no Git connection. With several,
 * both run on the connection the workspace's centralized config belongs to,
 * so a repository name never resolves against another connection's.
 */
const build = () => {
    const controller = Object.create(
        ParametersController.prototype,
    ) as ParametersController;
    const scoped = {
        organizationId: 'org-1',
        teamId: 'team-1',
        integrationId: 'gl-b',
    };
    const deps = {
        request: { user: { uuid: 'u-1', organization: { uuid: 'org-1' } } },
        connectionScope: {
            workspaceConfigScope: jest.fn().mockResolvedValue(scoped),
            downloadScope: jest.fn().mockResolvedValue({
                repositoryIds: ['2'],
                includeWorkspaceDefaults: true,
            }),
        },
        centralizedConfigSyncUseCase: {
            execute: jest.fn().mockResolvedValue({ success: true }),
        },
        centralizedConfigDownloadZipUseCase: {
            execute: jest.fn().mockResolvedValue({
                on: jest.fn(),
                pipe: jest.fn(),
            }),
        },
    };
    Object.assign(controller, deps);
    return { controller, scoped, ...deps };
};

describe('ParametersController — centralized config with several Git connections', () => {
    it("syncs on the connection the workspace's config belongs to", async () => {
        const { controller, scoped, centralizedConfigSyncUseCase } = build();

        await controller.syncCentralizedConfig({ teamId: 'team-1' });

        expect(centralizedConfigSyncUseCase.execute).toHaveBeenCalledWith({
            organizationAndTeamData: scoped,
        });
    });

    it("exports only that connection's repositories", async () => {
        const {
            controller,
            scoped,
            connectionScope,
            centralizedConfigDownloadZipUseCase,
        } = build();

        await controller.downloadCentralizedConfig(
            { set: jest.fn() } as any,
            'team-1',
        );

        expect(connectionScope.downloadScope).toHaveBeenCalledWith(scoped);
        expect(
            centralizedConfigDownloadZipUseCase.execute,
        ).toHaveBeenCalledWith(expect.anything(), 'team-1', {
            repositoryIds: ['2'],
            includeWorkspaceDefaults: true,
        });
    });
});
