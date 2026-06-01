import { ConfigService } from '@nestjs/config';

import { IntegrationConfigKey, PlatformType } from '@libs/core/domain/enums';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { GithubService } from './github.service';

describe('GithubService', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const previousRepositories = [
        { id: '1', name: 'repo-one' },
        { id: '2', name: 'repo-two' },
    ];
    const nextRepositories = [{ id: '2', name: 'repo-two' }];

    const integration = {
        uuid: 'integration-1',
        platform: PlatformType.GITHUB,
    };

    let integrationService: { findOne: jest.Mock };
    let authIntegrationService: Record<string, never>;
    let integrationConfigService: { createOrUpdateConfig: jest.Mock };
    let cacheService: Record<string, never>;
    let configService: ConfigService;
    let service: GithubService;

    beforeEach(() => {
        integrationService = {
            findOne: jest.fn().mockResolvedValue(integration),
        };

        authIntegrationService = {};

        integrationConfigService = {
            createOrUpdateConfig: jest.fn().mockResolvedValue({
                configValue: nextRepositories,
            }),
        };

        cacheService = {};
        configService = {
            get: jest.fn(),
        } as unknown as ConfigService;

        service = new GithubService(
            integrationService as any,
            authIntegrationService as any,
            integrationConfigService as any,
            cacheService as any,
            configService,
        );
    });

    it('updates the repository config before removing deselected webhooks and recreating selected ones', async () => {
        jest.spyOn(
            service,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue(previousRepositories);

        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.TOKEN,
        });

        const deleteWebhook = jest
            .spyOn(service, 'deleteWebhook')
            .mockResolvedValue(undefined);

        const createPullRequestWebhook = jest
            .spyOn(service, 'createPullRequestWebhook')
            .mockResolvedValue(undefined);

        await service.createOrUpdateIntegrationConfig({
            organizationAndTeamData,
            configKey: IntegrationConfigKey.REPOSITORIES,
            configValue: nextRepositories,
        });

        expect(deleteWebhook).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositories: [{ id: '1', name: 'repo-one' }],
        });
        expect(
            integrationConfigService.createOrUpdateConfig,
        ).toHaveBeenCalledWith(
            IntegrationConfigKey.REPOSITORIES,
            nextRepositories,
            integration.uuid,
            organizationAndTeamData,
            undefined,
        );
        expect(
            integrationConfigService.createOrUpdateConfig.mock
                .invocationCallOrder[0],
        ).toBeLessThan(deleteWebhook.mock.invocationCallOrder[0]);
        expect(createPullRequestWebhook).toHaveBeenCalledWith({
            organizationAndTeamData,
        });
    });

    it('does not touch webhooks for non-repository config updates', async () => {
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.TOKEN,
        });

        const deleteWebhook = jest
            .spyOn(service, 'deleteWebhook')
            .mockResolvedValue(undefined);

        const createPullRequestWebhook = jest
            .spyOn(service, 'createPullRequestWebhook')
            .mockResolvedValue(undefined);

        await service.createOrUpdateIntegrationConfig({
            organizationAndTeamData,
            configKey: IntegrationConfigKey.INSTALLATION_GITHUB,
            configValue: { installId: '123' },
        });

        expect(deleteWebhook).not.toHaveBeenCalled();
        expect(createPullRequestWebhook).not.toHaveBeenCalled();
    });

    it('uploads delete operations with valid tree mode/type', async () => {
        const octokitMock = {
            rest: {
                git: {
                    getRef: jest.fn().mockResolvedValue({
                        data: { object: { sha: 'base-sha' } },
                    }),
                    createBlob: jest.fn(),
                    createTree: jest.fn().mockResolvedValue({
                        data: { sha: 'tree-sha' },
                    }),
                    createCommit: jest.fn().mockResolvedValue({
                        data: { sha: 'commit-sha' },
                    }),
                    updateRef: jest.fn().mockResolvedValue({}),
                    createRef: jest.fn().mockResolvedValue({}),
                },
            },
        };

        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.TOKEN,
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(
            octokitMock as any,
        );
        jest.spyOn(service as any, 'getCorrectOwner').mockResolvedValue(
            'kodustech',
        );

        const result = await service.uploadFiles({
            organizationAndTeamData,
            repository: {
                id: 'repo-1',
                name: 'kodus',
            },
            branchName: 'main',
            baseBranch: 'main',
            files: [
                {
                    path: '.kody-rules/review/no-debug.yml',
                    operation: 'delete',
                },
            ],
            message: 'remove rule',
        });

        expect(result).toBe(true);
        expect(octokitMock.rest.git.createBlob).not.toHaveBeenCalled();
        expect(octokitMock.rest.git.createTree).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'kodustech',
                repo: 'kodus',
                tree: [
                    {
                        path: '.kody-rules/review/no-debug.yml',
                        mode: '100644',
                        type: 'blob',
                        sha: null,
                    },
                ],
            }),
        );
    });
});
