import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketService } from './bitbucket.service';
import { GitlabService } from './gitlab.service';

/** A service with only the collaborators the lookup touches. */
function serviceOf<T>(prototype: object, integrationConfigService: unknown): T {
    const service = Object.create(prototype) as T;
    Object.defineProperty(service, 'logger', {
        value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    });
    Object.defineProperty(service, 'integrationConfigService', {
        value: integrationConfigService,
    });
    return service;
}

describe('GitlabService — findTeamAndOrganizationIdByConfigKey resolves the project on the sending server', () => {
    // GitLab numbers projects per instance: project 9 is acme/web-shop on
    // gitlab-a.example and globex/billing-api on gitlab-b.example.
    const listed = (org: string, httpUrl: string, name: string) => ({
        team: { uuid: `team-${org}`, organization: { uuid: `org-${org}` } },
        integration: { authIntegration: { authDetails: {} } },
        configValue: [{ id: '9', name, http_url: httpUrl }],
    });
    const a = listed(
        'a',
        'https://gitlab-a.example/acme/web-shop.git',
        'acme/web-shop',
    );
    const b = listed(
        'b',
        'https://gitlab-b.example/globex/billing-api.git',
        'globex/billing-api',
    );

    const make = (configs: unknown[]) => {
        const findIntegrationConfigWithTeams = jest
            .fn()
            .mockResolvedValue(configs);
        const findOne = jest.fn();
        const service = serviceOf<GitlabService>(GitlabService.prototype, {
            findIntegrationConfigWithTeams,
            findOne,
        });
        return { service, findIntegrationConfigWithTeams, findOne };
    };

    it('returns the config on the sending server, read among active GitLab integrations', async () => {
        const { service, findIntegrationConfigWithTeams, findOne } = make([
            a,
            b,
        ]);

        const config = await service.findTeamAndOrganizationIdByConfigKey({
            repository: { id: 9, name: 'billing-api' },
            host: 'gitlab-b.example',
            repositoryFullName: 'globex/billing-api',
        });

        expect(config).toBe(b);
        expect(findIntegrationConfigWithTeams).toHaveBeenCalledWith(
            IntegrationConfigKey.REPOSITORIES,
            '9',
            PlatformType.GITLAB,
        );
        expect(findOne).not.toHaveBeenCalled();
    });

    it('returns nothing when only another server has the project id', async () => {
        const { service } = make([a]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 9, name: 'billing-api' },
                host: 'gitlab-b.example',
                repositoryFullName: 'globex/billing-api',
            }),
        ).resolves.toBeNull();
    });
});

describe.each([
    ['BitbucketService', BitbucketService.prototype, PlatformType.BITBUCKET],
    [
        'AzureReposService',
        AzureReposService.prototype,
        PlatformType.AZURE_REPOS,
    ],
])('%s — findTeamAndOrganizationIdByConfigKey', (_, prototype, platform) => {
    it('reads only active integrations of its own platform', async () => {
        const config = { configValue: [{ id: '42' }] };
        const findOne = jest.fn().mockResolvedValue(config);
        const service = serviceOf<{
            findTeamAndOrganizationIdByConfigKey(
                params: unknown,
            ): Promise<unknown>;
        }>(prototype, { findOne });

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 42 },
            }),
        ).resolves.toBe(config);
        expect(findOne).toHaveBeenCalledWith({
            configKey: IntegrationConfigKey.REPOSITORIES,
            configValue: [{ id: '42' }],
            integration: { status: true, platform },
        });
    });
});
