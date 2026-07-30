import { Test, TestingModule } from '@nestjs/testing';

import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { CodeManagementService } from '../codeManagement.service';
import { PlatformIntegrationFactory } from '../platformIntegration.factory';

describe('CodeManagementService issue dispatch', () => {
    let service: CodeManagementService;
    let factory: PlatformIntegrationFactory;
    let integrationService: { findOne: jest.Mock };

    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = { owner: 'kodustech', name: 'kodus-ai' };

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

    it('dispatches listIssues to the team platform implementation', async () => {
        usePlatform(PlatformType.GITHUB);
        const listIssues = jest.fn().mockResolvedValue([{ number: 1 }]);
        factory.registerCodeManagementService(PlatformType.GITHUB, {
            listIssues,
        } as any);

        const result = await service.listIssues({
            organizationAndTeamData: orgTeam,
            repository,
        });

        expect(listIssues).toHaveBeenCalledWith({
            organizationAndTeamData: orgTeam,
            repository,
        });
        expect(result).toEqual([{ number: 1 }]);
    });

    it('returns [] when the team has no code-management integration', async () => {
        integrationService.findOne.mockResolvedValue(null);

        expect(
            await service.listIssues({
                organizationAndTeamData: orgTeam,
                repository,
            }),
        ).toEqual([]);
    });

    it('throws when the platform does not implement issue reads', async () => {
        usePlatform(PlatformType.AZURE_REPOS);
        factory.registerCodeManagementService(PlatformType.AZURE_REPOS, {
            // no listIssues
        } as any);

        await expect(
            service.listIssues({
                organizationAndTeamData: orgTeam,
                repository,
            }),
        ).rejects.toThrow(/not supported/i);
    });

    it('dispatches getIssue and returns null with no integration', async () => {
        usePlatform(PlatformType.GITHUB);
        const getIssue = jest.fn().mockResolvedValue({ number: 7 });
        factory.registerCodeManagementService(PlatformType.GITHUB, {
            getIssue,
        } as any);

        expect(
            await service.getIssue({
                organizationAndTeamData: orgTeam,
                repository,
                issueNumber: 7,
            }),
        ).toEqual({ number: 7 });

        integrationService.findOne.mockResolvedValue(null);
        expect(
            await service.getIssue({
                organizationAndTeamData: orgTeam,
                repository,
                issueNumber: 7,
            }),
        ).toBeNull();
    });
});
