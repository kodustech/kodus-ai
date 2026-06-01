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
