import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { ForgejoService } from './forgejo.service';

describe('ForgejoService — findTeamAndOrganizationIdByConfigKey resolves the repository on the sending instance', () => {
    // Forgejo numbers repositories per instance: repository 26 is
    // alpha/app on git.alpha.example and beta/api on
    // git.beta.example.
    const configOn = (
        host: string,
        org: string,
        repositoryFullName: string,
    ) => ({
        team: { uuid: `team-${org}`, organization: { uuid: `org-${org}` } },
        integration: { authIntegration: { authDetails: { host } } },
        configValue: [{ id: '26', name: repositoryFullName }],
    });
    const alpha = configOn('https://git.alpha.example', 'alpha', 'alpha/app');
    const beta = configOn('https://git.beta.example', 'beta', 'beta/api');

    const makeService = (configs: unknown[]) => {
        const service = Object.create(
            ForgejoService.prototype,
        ) as ForgejoService;
        const findIntegrationConfigWithTeams = jest
            .fn()
            .mockResolvedValue(configs);

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        Object.defineProperty(service, 'integrationConfigService', {
            value: { findIntegrationConfigWithTeams, findOne: jest.fn() },
        });

        return { service, findIntegrationConfigWithTeams };
    };

    it('returns the config of the instance that sent the webhook', async () => {
        const { service, findIntegrationConfigWithTeams } = makeService([
            alpha,
            beta,
        ]);

        const config = await service.findTeamAndOrganizationIdByConfigKey({
            repository: { id: 26, name: 'beta/api' },
            host: 'git.beta.example',
        });

        expect(config).toBe(beta);
        expect(findIntegrationConfigWithTeams).toHaveBeenCalledWith(
            IntegrationConfigKey.REPOSITORIES,
            '26',
            PlatformType.FORGEJO,
        );
    });

    it('returns nothing when only another instance has the repository id', async () => {
        const { service } = makeService([alpha]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 26, name: 'beta/api' },
                host: 'git.beta.example',
            }),
        ).resolves.toBeNull();
    });

    it('returns the config of an instance stored at another address that keeps the repository', async () => {
        const internal = configOn('http://forgejo:3000', 'beta', 'beta/api');
        const { service } = makeService([alpha, internal]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 26, name: 'beta/api' },
                host: 'git.beta.example',
            }),
        ).resolves.toBe(internal);
    });

    it('returns nothing, and looks nothing up, without a repository id', async () => {
        const { service, findIntegrationConfigWithTeams } = makeService([
            alpha,
        ]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: '' },
                host: 'git.alpha.example',
            }),
        ).resolves.toBeNull();
        expect(findIntegrationConfigWithTeams).not.toHaveBeenCalled();
    });
});
