import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { IntegrationConfigService } from './integrationConfig.service';

const createDeferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });

    return { promise, resolve };
};

describe('IntegrationConfigService', () => {
    it('waits for repository config updates before resolving', async () => {
        const deferred = createDeferred<any>();
        const repository = {
            savePrivateChannel: jest.fn(),
            findOneIntegrationConfigWithIntegrations: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn().mockResolvedValue({
                uuid: 'config-1',
                configValue: [{ id: 'old-repo' }],
            }),
            findByOrganizationName: jest.fn(),
            findByInstallId: jest.fn(),
            findById: jest.fn(),
            findIntegrationConfigWithTeams: jest.fn(),
            create: jest.fn(),
            update: jest.fn().mockImplementation(() => deferred.promise),
            delete: jest.fn(),
        } as any;

        const service = new IntegrationConfigService(repository);
        const organizationAndTeamData = {
            organizationId: 'org-1',
            teamId: 'team-1',
        };
        const updatedConfig = {
            uuid: 'config-1',
            configValue: [{ id: 'new-repo', selected: true }],
        };

        const updatePromise = service.createOrUpdateConfig(
            IntegrationConfigKey.REPOSITORIES,
            [{ id: 'new-repo', selected: true }],
            'integration-1',
            organizationAndTeamData,
        );

        deferred.resolve(updatedConfig);

        await expect(updatePromise).resolves.toEqual(updatedConfig);
        expect(repository.update).toHaveBeenCalledTimes(1);
    });
});

describe('IntegrationConfigService.findIntegrationConfigFormatted — connections', () => {
    const repositoryWith = (
        configs: Array<{ integrationId: string; value: unknown }>,
    ) =>
        ({
            findOneIntegrationConfigWithIntegrations: jest.fn(
                async (_key: unknown, orgTeam: { integrationId?: string }) =>
                    configs.find(
                        (c) =>
                            !orgTeam.integrationId ||
                            c.integrationId === orgTeam.integrationId,
                    ) && {
                        configValue: configs.find(
                            (c) =>
                                !orgTeam.integrationId ||
                                c.integrationId === orgTeam.integrationId,
                        )!.value,
                    },
            ),
            findAllOfTeamByConfigKey: jest.fn(async () =>
                configs.map((c) => ({ configValue: c.value })),
            ),
        }) as any;

    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

    it('lists the repositories of every connection in the workspace', async () => {
        const service = new IntegrationConfigService(
            repositoryWith([
                { integrationId: 'gh', value: [{ id: '1', name: 'api' }] },
                { integrationId: 'gl', value: [{ id: '2', name: 'web' }] },
            ]),
        );

        const repos = await service.findIntegrationConfigFormatted<
            Array<{ id: string }>
        >(IntegrationConfigKey.REPOSITORIES, orgTeam);

        expect(repos.map((r) => r.id)).toEqual(['1', '2']);
    });

    it('lists only the named connection’s repositories', async () => {
        const repository = repositoryWith([
            { integrationId: 'gh', value: [{ id: '1', name: 'api' }] },
            { integrationId: 'gl', value: [{ id: '2', name: 'web' }] },
        ]);
        const service = new IntegrationConfigService(repository);

        const repos = await service.findIntegrationConfigFormatted<
            Array<{ id: string }>
        >(IntegrationConfigKey.REPOSITORIES, {
            ...orgTeam,
            integrationId: 'gl',
        });

        expect(repos.map((r) => r.id)).toEqual(['2']);
        expect(repository.findAllOfTeamByConfigKey).not.toHaveBeenCalled();
    });

    it('returns null when no connection lists any repository', async () => {
        const service = new IntegrationConfigService(repositoryWith([]));

        await expect(
            service.findIntegrationConfigFormatted(
                IntegrationConfigKey.REPOSITORIES,
                orgTeam,
            ),
        ).resolves.toBeNull();
    });

    it('keeps reading a single config for other keys', async () => {
        const repository = repositoryWith([
            { integrationId: 'gh', value: { installId: '9' } },
        ]);
        const service = new IntegrationConfigService(repository);

        await expect(
            service.findIntegrationConfigFormatted(
                IntegrationConfigKey.INSTALLATION_GITHUB,
                orgTeam,
            ),
        ).resolves.toEqual({ installId: '9' });
        expect(repository.findAllOfTeamByConfigKey).not.toHaveBeenCalled();
    });
});
