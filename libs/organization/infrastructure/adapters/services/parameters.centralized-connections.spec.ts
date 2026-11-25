import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';

import { ParametersService } from './parameters.service';

const stored = {
    enabled: true,
    repository: { id: 'r-gh', name: 'acme/config' },
    integrationId: 'gh-a',
    connections: {
        'gl-b': { enabled: true, repository: { id: 'r-gl', name: 'g/config' } },
    },
};

const build = (configValue: unknown = stored) => {
    const entity = ParametersEntity.create({
        uuid: 'p-1',
        configKey: ParametersKey.CENTRALIZED_CONFIG,
        configValue: configValue as any,
        team: { uuid: 'team-1' } as any,
        active: true,
        version: 1,
    });
    const repository = {
        findByKey: jest.fn(async () => entity),
        findOne: jest.fn(async () => entity),
        update: jest.fn(async () => entity),
        create: jest.fn(async (x: unknown) => x),
    };
    return { service: new ParametersService(repository as any), repository };
};

describe('ParametersService centralized config per Git connection', () => {
    it("answers the named connection's config", async () => {
        const { service } = build();

        const parameter = await service.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                integrationId: 'gl-b',
            },
        );

        expect(parameter.configValue).toEqual({
            enabled: true,
            repository: { id: 'r-gl', name: 'g/config' },
            connectionScoped: true,
        });
        expect(parameter.uuid).toBe('p-1');
    });

    it('answers the stored config, without the other connections, when none is named', async () => {
        const { service } = build();

        const parameter = await service.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            { organizationId: 'org-1', teamId: 'team-1' },
        );

        expect(parameter.configValue).toEqual({
            enabled: true,
            repository: { id: 'r-gh', name: 'acme/config' },
            integrationId: 'gh-a',
        });
    });

    it("saves a connection's config without touching the workspace's", async () => {
        const { service, repository } = build();

        await service.createOrUpdateConfig(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                enabled: true,
                repository: { id: 'r-gl2', name: 'g/config2' },
                connectionScoped: true,
            },
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                integrationId: 'gl-b',
            },
        );

        expect(repository.update.mock.calls[0][1].configValue).toEqual({
            enabled: true,
            repository: { id: 'r-gh', name: 'acme/config' },
            integrationId: 'gh-a',
            connections: {
                'gl-b': {
                    enabled: true,
                    repository: { id: 'r-gl2', name: 'g/config2' },
                },
            },
        });
    });

    it("saves the workspace's config keeping the other connections'", async () => {
        const { service, repository } = build();

        await service.createOrUpdateConfig(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                enabled: false,
                repository: { id: 'r-gh', name: 'acme/config' },
            },
            { organizationId: 'org-1', teamId: 'team-1' },
        );

        expect(repository.update.mock.calls[0][1].configValue).toEqual({
            enabled: false,
            repository: { id: 'r-gh', name: 'acme/config' },
            integrationId: 'gh-a',
            connections: stored.connections,
        });
    });
});
