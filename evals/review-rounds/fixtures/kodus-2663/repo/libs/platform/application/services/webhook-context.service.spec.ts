import { Test, TestingModule } from '@nestjs/testing';
import { WebhookContextService } from './webhook-context.service';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { TEAM_AUTOMATION_SERVICE_TOKEN } from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { AUTOMATION_SERVICE_TOKEN } from '@libs/automation/domain/automation/contracts/automation.service';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

describe('WebhookContextService', () => {
    let service: WebhookContextService;
    let integrationConfigServiceMock: any;
    let teamAutomationServiceMock: any;
    let automationServiceMock: any;

    const buildConfig = (
        organizationId: string,
        teamId: string,
        host?: string,
    ) => ({
        team: {
            uuid: teamId,
            organization: { uuid: organizationId },
        },
        integration: {
            authIntegration: {
                authDetails: host ? { host } : {},
            },
        },
    });

    beforeEach(async () => {
        integrationConfigServiceMock = {
            findIntegrationConfigWithTeams: jest.fn(),
        };
        teamAutomationServiceMock = {
            find: jest.fn().mockResolvedValue([{ uuid: 'team-auto-uuid' }]),
        };
        automationServiceMock = {
            find: jest.fn().mockResolvedValue([{ uuid: 'auto-uuid' }]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WebhookContextService,
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: integrationConfigServiceMock,
                },
                {
                    provide: TEAM_AUTOMATION_SERVICE_TOKEN,
                    useValue: teamAutomationServiceMock,
                },
                {
                    provide: AUTOMATION_SERVICE_TOKEN,
                    useValue: automationServiceMock,
                },
            ],
        }).compile();

        service = module.get<WebhookContextService>(WebhookContextService);
    });

    it('should return context when config is found', async () => {
        const platformType = PlatformType.GITHUB;
        const repositoryId = '123';
        const config = buildConfig('org-uuid', 'team-uuid');

        integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
            [config],
        );

        const result = await service.getContext(platformType, repositoryId);

        expect(result).toEqual({
            organizationAndTeamData: {
                organizationId: 'org-uuid',
                teamId: 'team-uuid',
            },
            teamAutomationId: 'team-auto-uuid',
        });
        expect(
            integrationConfigServiceMock.findIntegrationConfigWithTeams,
        ).toHaveBeenCalledWith(
            IntegrationConfigKey.REPOSITORIES,
            repositoryId,
            platformType,
        );
    });

    it('should return null when config is not found', async () => {
        integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
            [],
        );

        const result = await service.getContext(PlatformType.GITHUB, '123');

        expect(result).toBeNull();
    });

    it('should return null when config is incomplete', async () => {
        const config = {
            team: {
                // missing uuid
                organization: { uuid: 'org-uuid' },
            },
        };
        integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
            [config],
        );

        const result = await service.getContext(PlatformType.GITHUB, '123');

        expect(result).toBeNull();
    });

    describe('host disambiguation', () => {
        it('picks the config matching disambiguator.host when multiple configs share repositoryId across self-hosted instances', async () => {
            // Real-world scenario: two GitLab self-hosted instances both have a
            // project with id=93. Without disambiguation the first one (sorted
            // by updatedAt DESC) wins and the webhook is routed to the wrong org.
            const configD = buildConfig('org-d', 'team-d', 'gitlab-d.example');
            const configC = buildConfig('org-c', 'team-c', 'gitlab-c.example');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configD, configC],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93', {
                host: 'gitlab-c.example',
            });

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-c',
            );
            expect(result?.organizationAndTeamData.teamId).toBe('team-c');
        });

        it('normalises host (full URL, trailing slash, casing) before comparing', async () => {
            const configA = buildConfig('org-a', 'team-a', 'GitLab-C.Example');
            const configB = buildConfig('org-b', 'team-b', 'gitlab-d.example');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configA, configB],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93', {
                host: 'https://gitlab-c.example/initech/portal',
            });

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-a',
            );
        });

        it('refuses a webhook from a host no config is on', async () => {
            const configA = buildConfig('org-a', 'team-a', 'host-a.com');
            const configB = buildConfig('org-b', 'team-b', 'host-b.com');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configA, configB],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93', {
                host: 'unrelated.host',
            });

            expect(result).toBeNull();
        });

        it('never routes to the only config when it is on another instance', async () => {
            // Project 9 of gitlab-b.example, sent while only gitlab-a's
            // project 9 is connected: the webhook belongs to no organization.
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [buildConfig('org-a', 'team-a', 'gitlab-a.example')],
            );

            const result = await service.getContext(PlatformType.GITLAB, '9', {
                host: 'gitlab-b.example',
                repositoryFullName: 'other/project',
            });

            expect(result).toBeNull();
        });

        it('takes the config whose listed repository is on the sending host, when the integration stores none', async () => {
            const listedOn = (org: string, httpUrl: string) => ({
                ...buildConfig(org, `team-${org}`),
                configValue: [
                    { id: '9', name: `${org}/app`, http_url: httpUrl },
                ],
            });
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [
                    listedOn('org-a', 'https://gitlab-a.example/org-a/app.git'),
                    listedOn('org-b', 'https://gitlab-b.example/org-b/app.git'),
                ],
            );

            const result = await service.getContext(PlatformType.GITLAB, '9', {
                host: 'gitlab-b.example',
            });

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-b',
            );
        });

        it('refuses a webhook that names no instance when the configs are on known hosts', async () => {
            const configA = buildConfig('org-a', 'team-a', 'host-a.com');
            const configB = buildConfig('org-b', 'team-b', 'host-b.com');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configA, configB],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93');

            expect(result).toBeNull();
        });

        it('takes the config on the sending host beside a legacy config that stores no host', async () => {
            const configWithoutHost = buildConfig('org-legacy', 'team-legacy');
            const configC = buildConfig('org-c', 'team-c', 'gitlab-c.example');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configWithoutHost, configC],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93', {
                host: 'gitlab-c.example',
            });

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-c',
            );
        });

        it('keeps taking the only config when no config stores any host (legacy data)', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [buildConfig('org-only', 'team-only')],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93', {
                host: 'gitlab.example.com',
            });

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-only',
            );
        });

        const listedAt = (org: string, httpUrl: string, name: string) => ({
            ...buildConfig(org, `team-${org}`),
            configValue: [{ id: '9', name, http_url: httpUrl }],
        });

        it('never routes to a config whose listed project is on another server, even with the same path', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [
                    listedAt(
                        'org-a',
                        'https://gitlab-a.example/acme/api.git',
                        'acme/api',
                    ),
                ],
            );

            const result = await service.getContext(PlatformType.GITLAB, '9', {
                host: 'gitlab-b.example',
                repositoryFullName: 'acme/api',
            });

            expect(result).toBeNull();
        });

        it('keeps a legacy config that stores no host beside a config on another server', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [
                    buildConfig(
                        'org-other',
                        'team-other',
                        'gitlab-other.example',
                    ),
                    buildConfig('org-only', 'team-only'),
                ],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93', {
                host: 'gitlab.example.com',
            });

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-only',
            );
        });

        it('takes a config reached at an internal address that lists the same project and no URL', async () => {
            // Older configs list no repository URL, and Kodus may reach the
            // server at an IP while GitLab builds its URLs from external_url.
            const internal = {
                ...buildConfig('org-a', 'team-a', 'http://10.0.0.5:8080'),
                configValue: [{ id: '9', name: 'acme/api' }],
            };
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [internal],
            );

            const result = await service.getContext(PlatformType.GITLAB, '9', {
                host: 'gitlab.acme.example',
                repositoryFullName: 'acme/api',
            });

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-a',
            );
        });
    });

    describe('Forgejo', () => {
        // Forgejo numbers repositories per instance: repository 26 is
        // alpha/app on git.alpha.example and beta/api on
        // git.beta.example.
        const forgejoConfig = (
            org: string,
            host: string | undefined,
            repositoryFullName: string,
        ) => ({
            ...buildConfig(`org-${org}`, `team-${org}`, host),
            configValue: [{ id: '26', name: repositoryFullName }],
        });
        const alpha = forgejoConfig(
            'alpha',
            'https://git.alpha.example',
            'alpha/app',
        );
        const beta = forgejoConfig('beta', 'git.beta.example', 'beta/api');
        const fromBeta = {
            host: 'git.beta.example',
            repositoryFullName: 'beta/api',
        };

        it('routes the webhook to the integration on the instance that sent it', async () => {
            // A config with no host stored made the shared disambiguation
            // fall back to every candidate, and the first one took it.
            const noHost = forgejoConfig('other', undefined, 'other/app');
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [noHost, alpha, beta],
            );

            const result = await service.getContext(
                PlatformType.FORGEJO,
                '26',
                fromBeta,
            );

            expect(result?.organizationAndTeamData).toEqual({
                organizationId: 'org-beta',
                teamId: 'team-beta',
            });
        });

        it('routes the webhook to an instance stored at another address when it keeps the same repository', async () => {
            // Kodus reaches the instance at a docker service name while
            // Forgejo builds its URLs from ROOT_URL.
            const internal = forgejoConfig(
                'beta',
                'http://forgejo:3000',
                'Beta/API',
            );
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [alpha, internal],
            );

            const result = await service.getContext(
                PlatformType.FORGEJO,
                '26',
                fromBeta,
            );

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-beta',
            );
        });

        it('ignores the webhook when only another instance has the repository id', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [alpha],
            );
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            const result = await service.getContext(
                PlatformType.FORGEJO,
                '26',
                fromBeta,
            );

            expect(result).toBeNull();
            expect(teamAutomationServiceMock.find).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({
                        host: 'git.beta.example',
                        repositoryFullName: 'beta/api',
                        connected: [
                            {
                                organizationId: 'org-alpha',
                                host: 'https://git.alpha.example',
                                repositoryFullName: 'alpha/app',
                            },
                        ],
                    }),
                }),
            );
        });

        it('ignores the webhook when the payload names neither host nor repository', async () => {
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [alpha],
            );

            const result = await service.getContext(PlatformType.FORGEJO, '26');

            expect(result).toBeNull();
        });
    });

    describe('observability', () => {
        it('logs a warning when a connected repository has no active code review automation', async () => {
            const config = buildConfig('org-uuid', 'team-uuid');
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [config],
            );
            // Integration config exists, but no ACTIVE team automation — the
            // silent-drop window (e.g. webhook right after onboarding).
            teamAutomationServiceMock.find.mockResolvedValue([]);
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            const result = await service.getContext(PlatformType.GITHUB, '123');

            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toEqual(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'no team has an active code review automation',
                    ),
                    metadata: expect.objectContaining({
                        repositoryId: '123',
                        candidateTeamIds: ['team-uuid'],
                    }),
                }),
            );
        });

        it('logs a warning when no code review automation is registered in the system', async () => {
            const config = buildConfig('org-uuid', 'team-uuid');
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [config],
            );
            automationServiceMock.find.mockResolvedValue([]);
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            const result = await service.getContext(PlatformType.GITHUB, '123');

            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toEqual(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'no code review automation is registered',
                    ),
                }),
            );
        });

        it('does not warn when an active automation context is resolved', async () => {
            const config = buildConfig('org-uuid', 'team-uuid');
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [config],
            );
            const warnSpy = jest
                .spyOn((service as any).logger, 'warn')
                .mockImplementation(() => undefined);

            const result = await service.getContext(PlatformType.GITHUB, '123');

            expect(result).not.toBeNull();
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });
});
