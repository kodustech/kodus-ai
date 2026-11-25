import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketService } from './bitbucket.service';
import { GithubService } from './github/github.service';
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
        // The id-only lookup the method used to run: it finds the first
        // config listing the id, whatever its server.
        const findOne = jest.fn().mockResolvedValue(configs[0] ?? null);
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
        const { service, findOne } = make([a]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 9, name: 'billing-api' },
                host: 'gitlab-b.example',
                repositoryFullName: 'globex/billing-api',
            }),
        ).resolves.toBeNull();
        expect(findOne).not.toHaveBeenCalled();
    });

    it('returns nothing when another server has the same path under the same id', async () => {
        const sameOnA = listed(
            'a',
            'https://gitlab-a.example/globex/billing-api.git',
            'globex/billing-api',
        );
        const { service } = make([sameOnA]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 9, name: 'billing-api' },
                host: 'gitlab-b.example',
                repositoryFullName: 'globex/billing-api',
            }),
        ).resolves.toBeNull();
    });
});

describe('GithubService — findTeamAndOrganizationIdByConfigKey', () => {
    // Two GitHub Enterprise Servers each have a repository 9.
    const listedAt = (org: string, htmlUrl: string) => ({
        team: { uuid: `team-${org}`, organization: { uuid: `org-${org}` } },
        configValue: [{ id: '9', name: 'acme/api', http_url: htmlUrl }],
    });
    const onA = listedAt('a', 'https://ghe-a.example/acme/api');
    const onB = listedAt('b', 'https://ghe-b.example/acme/api');

    const make = (configs: unknown[]) => {
        const findIntegrationConfigWithTeams = jest
            .fn()
            .mockResolvedValue(configs);
        // The id-only lookup: the first config listing the id.
        const findOne = jest.fn().mockResolvedValue(configs[0] ?? null);
        const service = serviceOf<GithubService>(GithubService.prototype, {
            findIntegrationConfigWithTeams,
            findOne,
        });
        return { service, findOne };
    };

    it('returns the config on the sending server', async () => {
        const { service, findOne } = make([onA, onB]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 9 },
                host: 'ghe-b.example',
                repositoryFullName: 'acme/api',
            }),
        ).resolves.toBe(onB);
        expect(findOne).not.toHaveBeenCalled();
    });

    it('returns nothing when only another server has the repository id', async () => {
        const { service } = make([onA]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 9 },
                host: 'ghe-b.example',
                repositoryFullName: 'acme/api',
            }),
        ).resolves.toBeNull();
    });

    it('keeps the id lookup when the caller names no server', async () => {
        const { service, findOne } = make([onA]);

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 9 },
            }),
        ).resolves.toBe(onA);
        expect(findOne).toHaveBeenCalledWith({
            configKey: IntegrationConfigKey.REPOSITORIES,
            configValue: [{ id: '9' }],
            integration: { status: true, platform: PlatformType.GITHUB },
        });
    });
});

describe('BitbucketService — findTeamAndOrganizationIdByConfigKey on Data Center', () => {
    const listed = (org: string, name: string, workspaceId: string) => ({
        team: { uuid: `team-${org}`, organization: { uuid: `org-${org}` } },
        configValue: [{ id: '84', name, workspaceId }],
    });
    const onA = listed('a', 'billing', 'FIN');
    const onB = listed('b', 'portal', 'WEB');

    it('returns the config with the same project key and slug, never the first by id', async () => {
        const findIntegrationConfigWithTeams = jest
            .fn()
            .mockResolvedValue([onA, onB]);
        const findOne = jest.fn().mockResolvedValue(onA);
        const service = serviceOf<BitbucketService>(
            BitbucketService.prototype,
            { findIntegrationConfigWithTeams, findOne },
        );

        await expect(
            service.findTeamAndOrganizationIdByConfigKey({
                repository: { id: 84 },
                dataCenterRepository: { projectKey: 'WEB', slug: 'portal' },
            }),
        ).resolves.toBe(onB);
        expect(findOne).not.toHaveBeenCalled();
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
