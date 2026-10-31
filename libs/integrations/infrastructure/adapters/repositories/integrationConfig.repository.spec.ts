import { DataSource, Repository } from 'typeorm';

import { IntegrationConfigKey } from '@libs/core/domain/enums';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';

import { IntegrationConfigRepository } from './integrationConfig.repository';
import { IntegrationConfigModel } from './schemas/integrationConfig.model';

describe('IntegrationConfigRepository.findOneIntegrationConfigWithIntegrations', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    let typeormRepository: Repository<IntegrationConfigModel>;
    let repository: IntegrationConfigRepository;

    beforeEach(() => {
        // No connection is initialized: only the TypeORM query edge is mocked.
        const dataSource = new DataSource({ type: 'postgres' });
        typeormRepository = dataSource.getRepository(IntegrationConfigModel);
        repository = new IntegrationConfigRepository(typeormRepository);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('rejects with the original error when the query fails', async () => {
        const error = new Error('integration config query failed');
        jest.spyOn(typeormRepository, 'findOne').mockRejectedValue(error);
        jest.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(
            repository.findOneIntegrationConfigWithIntegrations(
                IntegrationConfigKey.REPOSITORIES,
                organizationAndTeamData,
            ),
        ).rejects.toBe(error);
    });

    it('returns exactly undefined when a successful query finds no config', async () => {
        jest.spyOn(typeormRepository, 'findOne').mockResolvedValue(null);

        await expect(
            repository.findOneIntegrationConfigWithIntegrations(
                IntegrationConfigKey.REPOSITORIES,
                organizationAndTeamData,
            ),
        ).resolves.toBeUndefined();
    });

    it('maps a matching config to an entity and requests its integration relations', async () => {
        const model = new IntegrationConfigModel();
        model.uuid = 'config-1';
        model.configKey = IntegrationConfigKey.REPOSITORIES;
        model.configValue = [{ id: 'repo-1', selected: true }];
        const findOne = jest
            .spyOn(typeormRepository, 'findOne')
            .mockResolvedValue(model);

        const result =
            await repository.findOneIntegrationConfigWithIntegrations(
                IntegrationConfigKey.REPOSITORIES,
                organizationAndTeamData,
            );

        expect(result).toBeInstanceOf(IntegrationConfigEntity);
        expect(result.uuid).toBe(model.uuid);
        expect(result.configKey).toBe(model.configKey);
        expect(result.configValue).toEqual(model.configValue);
        expect(findOne).toHaveBeenCalledTimes(1);
        expect(findOne).toHaveBeenCalledWith({
            where: {
                configKey: IntegrationConfigKey.REPOSITORIES,
                integration: { organization: { uuid: 'org-1' } },
                team: { uuid: 'team-1' },
            },
            relations: [
                'integration',
                'integration.authIntegration',
                'integration.organization',
            ],
            order: { updatedAt: 'DESC' },
        });
    });
});
