import { ParametersKey } from '@libs/core/domain/enums';

import { CentralizedConfigConnectionScope } from '../../services/centralized-config-connection-scope.service';
import { CentralizedConfigInitUseCase } from '../centralized-config-init.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('CentralizedConfigInitUseCase per Git connection', () => {
    const workspace = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = { id: 'repo-gl-config', name: 'group/config' };

    const build = (opts: { connectionScoped: boolean }) => {
        const parametersService = {
            findByKey: jest.fn(async () => ({
                configValue: {
                    enabled: false,
                    repository: null,
                    ...(opts.connectionScoped
                        ? { connectionScoped: true }
                        : {}),
                },
            })),
        };
        const createOrUpdateParameters = { execute: jest.fn() };
        const download = { execute: jest.fn().mockResolvedValue([]) };
        const prService = {
            scopeToRepositoryConnection: jest.fn(async (otd: object) => ({
                ...otd,
                integrationId: 'gl-b',
            })),
            repositoryIdsOf: jest.fn(async () => [
                'repo-gl-1',
                'repo-gl-config',
            ]),
            createPullRequestInCentralizedRepo: jest
                .fn()
                .mockResolvedValue({ prUrl: 'https://example.test/pr/1' }),
        };
        const connectionScope = new CentralizedConfigConnectionScope(
            {
                find: jest.fn().mockResolvedValue([{ uuid: 'gl-b' }]),
            } as any,
            {
                findAllOfTeamByConfigKey: jest.fn().mockResolvedValue([
                    {
                        integration: { uuid: 'gl-b' },
                        configValue: [
                            { id: 'repo-gl-1' },
                            { id: 'repo-gl-config' },
                        ],
                    },
                ]),
            } as any,
            parametersService as any,
        );
        const useCase = new CentralizedConfigInitUseCase(
            parametersService as any,
            createOrUpdateParameters as any,
            download as any,
            prService as any,
            connectionScope,
        );
        return { useCase, createOrUpdateParameters, download, prService };
    };

    it('sets up the centralized config of the connection that lists the repository', async () => {
        const { useCase, createOrUpdateParameters, prService } = build({
            connectionScoped: true,
        });

        await useCase.execute({
            user: {},
            organizationAndTeamData: workspace,
            repository,
            syncOption: 'pr',
        });

        expect(prService.scopeToRepositoryConnection).toHaveBeenCalledWith(
            workspace,
            repository.id,
        );
        expect(createOrUpdateParameters.execute).toHaveBeenCalledWith(
            ParametersKey.CENTRALIZED_CONFIG,
            expect.objectContaining({ enabled: true, repository }),
            { ...workspace, integrationId: 'gl-b' },
        );
    });

    it("exports only that connection's repositories, without the workspace defaults, for a connection's own config", async () => {
        const { useCase, download } = build({ connectionScoped: true });

        await useCase.execute({
            user: {},
            organizationAndTeamData: workspace,
            repository,
            syncOption: 'pr',
        });

        expect(download.execute).toHaveBeenCalledWith(
            {},
            'team-1',
            expect.objectContaining({
                repositoryIds: ['repo-gl-1', 'repo-gl-config'],
                includeWorkspaceDefaults: false,
            }),
        );
    });

    it("keeps the workspace defaults in the export of the workspace's own config", async () => {
        const { useCase, download } = build({ connectionScoped: false });

        await useCase.execute({
            user: {},
            organizationAndTeamData: workspace,
            repository,
            syncOption: 'pr',
        });

        expect(download.execute).toHaveBeenCalledWith(
            {},
            'team-1',
            expect.objectContaining({
                repositoryIds: ['repo-gl-1', 'repo-gl-config'],
                includeWorkspaceDefaults: true,
            }),
        );
    });
});
