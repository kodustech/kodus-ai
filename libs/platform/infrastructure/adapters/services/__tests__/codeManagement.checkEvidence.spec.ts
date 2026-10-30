import { Test, TestingModule } from '@nestjs/testing';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { ICodeManagementService } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

import { CodeManagementService } from '../codeManagement.service';
import { PlatformIntegrationFactory } from '../platformIntegration.factory';

describe('CodeManagementService check-evidence dispatch', () => {
    let service: CodeManagementService;
    let factory: PlatformIntegrationFactory;
    let integrationService: { findOne: jest.Mock };

    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = { owner: 'acme', name: 'widget-api' };
    const commitSha = 'a1b2c3d4';

    const register = (
        platform: PlatformType,
        impl: Partial<ICodeManagementService>,
    ) =>
        factory.registerCodeManagementService(
            platform,
            impl as ICodeManagementService,
        );

    beforeEach(async () => {
        integrationService = { findOne: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CodeManagementService,
                PlatformIntegrationFactory,
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: integrationService,
                },
            ],
        }).compile();

        service = module.get(CodeManagementService);
        factory = module.get(PlatformIntegrationFactory);
    });

    const usePlatform = (platform: PlatformType) =>
        integrationService.findOne.mockResolvedValue({ platform });

    it('dispatches to the team platform implementation', async () => {
        usePlatform(PlatformType.GITHUB);
        const getCheckEvidence = jest
            .fn()
            .mockResolvedValue([{ name: 'semgrep' }]);
        register(PlatformType.GITHUB, { getCheckEvidence });

        const result = await service.getCheckEvidence({
            organizationAndTeamData: orgTeam,
            repository,
            commitSha,
        });

        expect(getCheckEvidence).toHaveBeenCalledWith({
            organizationAndTeamData: orgTeam,
            repository,
            commitSha,
        });
        expect(result).toEqual([{ name: 'semgrep' }]);
    });

    // Evidence is enrichment nobody asked for: a platform that cannot read it
    // must degrade to "no evidence", never fail the review around it. This is
    // the deliberate difference from listIssues, which throws.
    it('returns [] when the platform does not implement evidence reads', async () => {
        usePlatform(PlatformType.AZURE_REPOS);
        register(PlatformType.AZURE_REPOS, {});

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData: orgTeam,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });

    it('returns [] when the team has no code-management integration', async () => {
        integrationService.findOne.mockResolvedValue(null);

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData: orgTeam,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });

    it('returns [] when the provider call throws', async () => {
        usePlatform(PlatformType.GITHUB);
        register(PlatformType.GITHUB, {
            getCheckEvidence: jest
                .fn()
                .mockRejectedValue(new Error('rate limited')),
        });

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData: orgTeam,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });

    it('honours an explicitly passed platform without looking up the integration', async () => {
        const getCheckEvidence = jest.fn().mockResolvedValue([]);
        register(PlatformType.GITLAB, { getCheckEvidence });

        await service.getCheckEvidence(
            {
                organizationAndTeamData: orgTeam,
                repository,
                commitSha,
            },
            PlatformType.GITLAB,
        );

        expect(integrationService.findOne).not.toHaveBeenCalled();
        expect(getCheckEvidence).toHaveBeenCalled();
    });
});

describe('CodeManagementService check-evidence capability probe', () => {
    let service: CodeManagementService;
    let factory: PlatformIntegrationFactory;
    let integrationService: { findOne: jest.Mock };

    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

    beforeEach(async () => {
        integrationService = { findOne: jest.fn() };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CodeManagementService,
                PlatformIntegrationFactory,
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: integrationService,
                },
            ],
        }).compile();
        service = module.get(CodeManagementService);
        factory = module.get(PlatformIntegrationFactory);
    });

    const register = (
        platform: PlatformType,
        impl: Partial<ICodeManagementService>,
    ) =>
        factory.registerCodeManagementService(
            platform,
            impl as ICodeManagementService,
        );

    it('reports no support when the platform omits the reader', async () => {
        integrationService.findOne.mockResolvedValue({
            platform: PlatformType.FORGEJO,
        });
        register(PlatformType.FORGEJO, {});

        expect(await service.supportsCheckEvidence(orgTeam)).toEqual({
            statuses: false,
            annotations: false,
        });
    });

    // A platform that reads statuses but has no line-level concept must say so
    // rather than let callers infer "no findings" from an empty array.
    it('reports status-only support when the platform declares it', async () => {
        integrationService.findOne.mockResolvedValue({
            platform: PlatformType.AZURE_REPOS,
        });
        register(PlatformType.AZURE_REPOS, {
            getCheckEvidence: jest.fn(),
            supportsCheckEvidence: jest
                .fn()
                .mockResolvedValue({ statuses: true, annotations: false }),
        });

        expect(await service.supportsCheckEvidence(orgTeam)).toEqual({
            statuses: true,
            annotations: false,
        });
    });

    // Implementing the reader without the probe means statuses work; claiming
    // annotations would be a lie, so the default stays conservative.
    it('defaults to status-only when the reader exists but the probe does not', async () => {
        integrationService.findOne.mockResolvedValue({
            platform: PlatformType.GITHUB,
        });
        register(PlatformType.GITHUB, { getCheckEvidence: jest.fn() });

        expect(await service.supportsCheckEvidence(orgTeam)).toEqual({
            statuses: true,
            annotations: false,
        });
    });
});
