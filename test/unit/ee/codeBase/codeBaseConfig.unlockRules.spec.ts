import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * The server review path (getConfig) must self-heal plan-locked rules: on a
 * paid org (shouldLimitResources === false) every rule parked as
 * PAUSED + lockedByPlan:true is reactivated and applied in THIS review, so the
 * unlocked rules are what `filterKodyRules` receives — not the parked ones.
 */
describe('CodeBaseConfigService.getConfig — unlock plan-locked rules', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { id: 'repo-1', name: 'my-repo' };

    const lockedRule = {
        uuid: 'r-locked',
        status: KodyRulesStatus.PAUSED,
        lockedByPlan: true,
        repositoryId: 'repo-1',
    };
    const unlockedRule = {
        ...lockedRule,
        status: KodyRulesStatus.ACTIVE,
        lockedByPlan: false,
    };

    const buildService = (limited: boolean) => {
        const parametersService = {
            findOne: jest.fn().mockResolvedValue({ configValue: {} }),
            findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
        };
        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue({
                toObject: () => ({ rules: [lockedRule] }),
            }),
            unlockRulesLockedByPlan: jest.fn().mockResolvedValue({
                toObject: () => ({ rules: [unlockedRule] }),
            }),
        };
        const filterKodyRules = jest
            .fn()
            .mockReturnValue({ standardRules: [unlockedRule], memoryRules: [] });
        const kodyRulesValidationService = { filterKodyRules };
        const permissionValidationService = {
            shouldLimitResources: jest.fn().mockResolvedValue(limited),
        };
        const codeManagementService = {
            verifyConnection: jest
                .fn()
                .mockResolvedValue({ hasConnection: true, isSetupComplete: true }),
        };

        const service = new CodeBaseConfigService(
            {} as any, // integrationService
            {} as any, // integrationConfigService
            {} as any, // organizationParametersService
            parametersService as any,
            kodyRulesService as any,
            {} as any, // globalParametersService
            codeManagementService as any,
            kodyRulesValidationService as any,
            permissionValidationService as any,
            {} as any, // cacheService
        );

        // Stub the heavy helpers so the test isolates the unlock+filter seam.
        jest.spyOn(service as any, 'getDefaultBranch').mockResolvedValue('main');
        jest
            .spyOn(service as any, 'getReviewModeConfigParameter')
            .mockResolvedValue({});
        jest
            .spyOn(service as any, 'getKodyFineTuningConfigParameter')
            .mockResolvedValue({});
        jest
            .spyOn(service as any, 'getMergedCodeReviewConfigs')
            .mockResolvedValue({
                directoryId: undefined,
                ignorePaths: [],
                v2PromptOverrides: {},
            });
        jest.spyOn(service as any, 'getGlobalIgnorePaths').mockResolvedValue([]);
        jest
            .spyOn(service as any, 'sanitizeV2PromptOverrides')
            .mockReturnValue({});

        return { service, kodyRulesService, filterKodyRules };
    };

    it('unlocks and applies plan-locked rules on a paid plan', async () => {
        const { service, kodyRulesService, filterKodyRules } =
            buildService(false);

        await service.getConfig(organizationAndTeamData, repository);

        expect(kodyRulesService.unlockRulesLockedByPlan).toHaveBeenCalledWith(
            organizationAndTeamData,
            { limited: false, rules: [lockedRule] },
        );
        // filterKodyRules must receive the UNLOCKED (ACTIVE) rule.
        expect(filterKodyRules.mock.calls[0][0]).toEqual([unlockedRule]);
    });

    it('does not unlock on a still-limited (Free) plan', async () => {
        const { service, kodyRulesService, filterKodyRules } =
            buildService(true);
        kodyRulesService.unlockRulesLockedByPlan.mockResolvedValue(null);

        await service.getConfig(organizationAndTeamData, repository);

        // With limited=true the unlock no-ops (returns null) and the parked
        // rule is what flows into filterKodyRules unchanged.
        expect(filterKodyRules.mock.calls[0][0]).toEqual([lockedRule]);
    });
});
