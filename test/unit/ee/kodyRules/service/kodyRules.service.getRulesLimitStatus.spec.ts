import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('KodyRulesService.getRulesLimitStatus', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildService = () => {
        const repositoryMock = {
            findByOrganizationId: jest.fn(),
            countRules: jest.fn().mockResolvedValue(7),
        };

        const validationService = new KodyRulesValidationService({} as any);

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            validationService,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, repositoryMock };
    };

    // Regression: the old implementation called findByOrganizationId
    // (which loads the full embedded rules array — can be hundreds of
    // KB on active orgs) and filtered in JS just to return a count.
    // The repo now exposes a server-side countRules aggregation and
    // the service must use it.
    it('delegates to countRules with status ACTIVE', async () => {
        const { service, repositoryMock } = buildService();

        const result = await service.getRulesLimitStatus(organizationAndTeamData);

        expect(result).toEqual({ total: 7 });
        expect(repositoryMock.countRules).toHaveBeenCalledWith(
            'org-1',
            KodyRulesStatus.ACTIVE,
        );
        // The fat load+filter path must NOT be taken anymore.
        expect(repositoryMock.findByOrganizationId).not.toHaveBeenCalled();
    });

    it('returns 0 when the org has no rules yet', async () => {
        const { service, repositoryMock } = buildService();
        repositoryMock.countRules.mockResolvedValue(0);

        const result = await service.getRulesLimitStatus(organizationAndTeamData);

        expect(result).toEqual({ total: 0 });
    });

    it('propagates repository errors to the caller', async () => {
        const { service, repositoryMock } = buildService();
        repositoryMock.countRules.mockRejectedValue(new Error('mongo down'));

        await expect(
            service.getRulesLimitStatus(organizationAndTeamData),
        ).rejects.toThrow('mongo down');
    });
});
