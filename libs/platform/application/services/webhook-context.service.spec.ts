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

    it('should be defined', () => {
        expect(service).toBeDefined();
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
            const omarHerreraConfig = buildConfig(
                'org-omar',
                'team-omar',
                'vcs.789.com.mx',
            );
            const ikatecConfig = buildConfig(
                'org-ikatec',
                'team-ikatec',
                'gitlab.ikatec.cloud',
            );

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [omarHerreraConfig, ikatecConfig],
            );

            const result = await service.getContext(
                PlatformType.GITLAB,
                '93',
                { host: 'gitlab.ikatec.cloud' },
            );

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-ikatec',
            );
            expect(result?.organizationAndTeamData.teamId).toBe('team-ikatec');
        });

        it('normalises host (full URL, trailing slash, casing) before comparing', async () => {
            const configA = buildConfig('org-a', 'team-a', 'GitLab.IKATEC.cloud');
            const configB = buildConfig('org-b', 'team-b', 'vcs.789.com.mx');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configA, configB],
            );

            const result = await service.getContext(
                PlatformType.GITLAB,
                '93',
                { host: 'https://gitlab.ikatec.cloud/agnus/agnuscloud' },
            );

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-a',
            );
        });

        it('falls back to original candidates when no config matches the host (never worse than current behaviour)', async () => {
            const configA = buildConfig('org-a', 'team-a', 'host-a.com');
            const configB = buildConfig('org-b', 'team-b', 'host-b.com');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configA, configB],
            );

            const result = await service.getContext(
                PlatformType.GITLAB,
                '93',
                { host: 'unrelated.host' },
            );

            // Falls back to the first candidate from the original list.
            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-a',
            );
        });

        it('falls back to original candidates when disambiguator is missing', async () => {
            const configA = buildConfig('org-a', 'team-a', 'host-a.com');
            const configB = buildConfig('org-b', 'team-b', 'host-b.com');

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configA, configB],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93');

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-a',
            );
        });

        it('falls back to original candidates when any colliding config has no host stored (legacy data) — never picks a partial winner', async () => {
            // If a legacy IntegrationConfig was created before host was being
            // persisted, it would be silently excluded from the filter and
            // we could end up picking the wrong "matching" config. Better to
            // fall back to current behaviour than risk a wrong routing.
            const configWithoutHost = buildConfig('org-legacy', 'team-legacy');
            const configIkatec = buildConfig(
                'org-ikatec',
                'team-ikatec',
                'gitlab.ikatec.cloud',
            );

            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [configWithoutHost, configIkatec],
            );

            const result = await service.getContext(
                PlatformType.GITLAB,
                '93',
                { host: 'gitlab.ikatec.cloud' },
            );

            // Without the safeguard the filter would pick configIkatec, which
            // might be wrong if the legacy config (org-legacy) was actually the
            // intended target. Falling back keeps current (imperfect but
            // unchanged) behaviour: first candidate by updatedAt DESC.
            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-legacy',
            );
        });

        it('does not require disambiguator when only one config matches', async () => {
            const config = buildConfig('org-only', 'team-only', 'host-a.com');
            integrationConfigServiceMock.findIntegrationConfigWithTeams.mockResolvedValue(
                [config],
            );

            const result = await service.getContext(PlatformType.GITLAB, '93');

            expect(result?.organizationAndTeamData.organizationId).toBe(
                'org-only',
            );
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
