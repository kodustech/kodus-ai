import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';

import { AzureReposService } from './azureRepos/azureRepos.service';
import { BitbucketCloudService } from './bitbucket/bitbucket-cloud.service';
import { GithubService } from './github/github.service';

/**
 * The repository selection is saved from one shared modal used by every
 * provider, and that modal posts in chunks of 50 with the first chunk as
 * `replace` and the rest as `append`.
 *
 * Every adapter sets up webhooks from `createOrUpdateIntegrationConfig`, and
 * they all read the persisted selection to decide what to do. An intermediate
 * chunk therefore shows them a partial selection: with 200 repositories, the
 * first chunk persists 50, and the adapters that remove webhooks outside the
 * selection delete the other 150 — which the later chunks then recreate. In
 * between, those repositories deliver no PR events, and the hooks never come
 * back if the process dies mid-save.
 *
 * `deferWebhooks` is how the client says "this request is not the whole
 * selection". These tests pin both halves of that contract: an intermediate
 * chunk must not touch webhooks, and everything that does not send the flag
 * (the per-row remove, the onboarding save, the per-provider modals, the CLI)
 * must keep behaving exactly as before.
 */

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

describe('webhook setup is deferred until a chunked save is complete', () => {
    describe('AzureReposService', () => {
        let service: AzureReposService;
        let createWebhook: jest.SpyInstance;

        beforeEach(() => {
            service = new AzureReposService(
                {
                    findOne: jest
                        .fn()
                        .mockResolvedValue({ uuid: 'integration-1' }),
                } as any,
                { createOrUpdateConfig: jest.fn() } as any,
                {} as any,
                {} as any,
                { get: jest.fn() } as any,
                undefined,
            );

            createWebhook = jest
                .spyOn(service, 'createWebhook')
                .mockResolvedValue(undefined);
        });

        it('does not set up webhooks for an intermediate chunk', async () => {
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a' }],
                type: 'replace',
                deferWebhooks: true,
                organizationAndTeamData: orgTeam,
            });

            expect(createWebhook).not.toHaveBeenCalled();
        });

        it('sets up webhooks for the final chunk', async () => {
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a' }],
                type: 'append',
                deferWebhooks: false,
                organizationAndTeamData: orgTeam,
            });

            expect(createWebhook).toHaveBeenCalledTimes(1);
        });

        it('sets up webhooks when the flag is absent, as every other caller sends it', async () => {
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a' }],
                type: 'replace',
                organizationAndTeamData: orgTeam,
            });

            expect(createWebhook).toHaveBeenCalledTimes(1);
        });

        it('persists the configuration either way', async () => {
            const createOrUpdateConfig = jest.fn();
            (service as any).integrationConfigService = {
                createOrUpdateConfig,
            };

            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a' }],
                type: 'replace',
                deferWebhooks: true,
                organizationAndTeamData: orgTeam,
            });

            // Deferring webhooks must never defer the save itself.
            expect(createOrUpdateConfig).toHaveBeenCalledTimes(1);
        });
    });

    describe('GithubService — the adapter that already removes webhooks', () => {
        let service: GithubService;
        let deleteWebhook: jest.SpyInstance;
        let createPullRequestWebhook: jest.SpyInstance;

        beforeEach(() => {
            service = new GithubService(
                {
                    findOne: jest
                        .fn()
                        .mockResolvedValue({ uuid: 'integration-1' }),
                } as any, // integrationService
                {} as any, // authIntegrationService
                { createOrUpdateConfig: jest.fn() } as any, // integrationConfigService
                {} as any, // cacheService
                { get: jest.fn() } as any, // configService
                undefined, // mcpManagerService
            );

            jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue(
                { authMode: 'token' },
            );
            jest.spyOn(
                service as any,
                'findOneByOrganizationAndTeamDataAndConfigKey',
            ).mockResolvedValue([
                { id: 'repo-a', name: 'frontend-app' },
                { id: 'repo-b', name: 'backend-api' },
            ]);

            deleteWebhook = jest
                .spyOn(service, 'deleteWebhook')
                .mockResolvedValue(undefined);
            createPullRequestWebhook = jest
                .spyOn(service as any, 'createPullRequestWebhook')
                .mockResolvedValue(undefined);
        });

        it('does not delete the webhooks of repositories missing from an intermediate chunk', async () => {
            // Without the flag this is the live bug: the chunk persists one
            // repository, so repo-b looks deselected and loses its webhook.
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a', name: 'frontend-app' }],
                type: 'replace',
                deferWebhooks: true,
                organizationAndTeamData: orgTeam,
            });

            expect(deleteWebhook).not.toHaveBeenCalled();
            expect(createPullRequestWebhook).not.toHaveBeenCalled();
        });

        it('reconciles on the final chunk without removing a repository the append keeps', async () => {
            // An append only adds to the selection: repo-b stays selected,
            // so its webhook must stay too. Deleting it here and recreating
            // it right after is the churn QA saw on #2004 (new hook ids, and
            // PR events lost in between).
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a', name: 'frontend-app' }],
                type: 'append',
                organizationAndTeamData: orgTeam,
            });

            expect(createPullRequestWebhook).toHaveBeenCalledTimes(1);
            expect(deleteWebhook).not.toHaveBeenCalled();
        });

        it('keeps every selected webhook when one repository is appended', async () => {
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-c', name: 'billing' }],
                type: 'append',
                organizationAndTeamData: orgTeam,
            });

            expect(deleteWebhook).not.toHaveBeenCalled();
            expect(createPullRequestWebhook).toHaveBeenCalledTimes(1);
        });

        it('still removes the webhook of a repository a replace leaves out', async () => {
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a', name: 'frontend-app' }],
                type: 'replace',
                organizationAndTeamData: orgTeam,
            });

            expect(deleteWebhook).toHaveBeenCalledTimes(1);
            expect(deleteWebhook.mock.calls[0][0].repositories).toEqual([
                { id: 'repo-b', name: 'backend-api' },
            ]);
        });
    });

    describe('BitbucketCloudService', () => {
        let service: BitbucketCloudService;
        let createWebhook: jest.SpyInstance;

        beforeEach(() => {
            service = new BitbucketCloudService(
                {
                    findOne: jest
                        .fn()
                        .mockResolvedValue({ uuid: 'integration-1' }),
                } as any,
                { createOrUpdateConfig: jest.fn() } as any,
                {} as any,
                {} as any,
            );

            createWebhook = jest
                .spyOn(service, 'createWebhook')
                .mockResolvedValue(undefined);
        });

        it('does not set up webhooks for an intermediate chunk', async () => {
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a' }] as any,
                type: 'replace',
                deferWebhooks: true,
                organizationAndTeamData: orgTeam,
            });

            expect(createWebhook).not.toHaveBeenCalled();
        });

        it('sets up webhooks when the flag is absent', async () => {
            await service.createOrUpdateIntegrationConfig({
                configKey: IntegrationConfigKey.REPOSITORIES,
                configValue: [{ id: 'repo-a' }] as any,
                type: 'replace',
                organizationAndTeamData: orgTeam,
            });

            expect(createWebhook).toHaveBeenCalledTimes(1);
        });
    });
});
