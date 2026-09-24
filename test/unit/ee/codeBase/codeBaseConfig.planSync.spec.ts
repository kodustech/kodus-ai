import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * The server review path (getConfig) reconciles the rules' lock state with the
 * current plan before the review uses them — a fail-safe for a missed
 * plan-change webhook. It reuses the entity + `limited` it already resolved, so
 * the sync does no extra lookup, and the review applies the reconciled set.
 */
describe('CodeBaseConfigService.getConfig — plan-limit reconciliation', () => {
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
        const loadedEntity = { toObject: () => ({ rules: [lockedRule] }) };

        const parametersService = {
            findOne: jest.fn().mockResolvedValue({ configValue: {} }),
            findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
        };
        const kodyRulesService = {
            findByOrganizationId: jest.fn().mockResolvedValue(loadedEntity),
            // Paid → reconcile returns the fresh doc with the rule reactivated.
            syncRulesWithPlanLimit: jest.fn().mockResolvedValue({
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
        jest
            .spyOn(service as any, 'sanitizeV2PromptOverrides')
            .mockReturnValue({});

        return { service, kodyRulesService, filterKodyRules, loadedEntity };
    };

    it('reconciles before the review and applies the synced rules (paid plan)', async () => {
        const { service, kodyRulesService, filterKodyRules, loadedEntity } =
            buildService(false);

        await service.getConfig(organizationAndTeamData, repository);

        // Called with the already-loaded entity + the resolved plan gate.
        expect(kodyRulesService.syncRulesWithPlanLimit).toHaveBeenCalledWith(
            organizationAndTeamData,
            { entity: loadedEntity, limited: false },
        );
        // filterKodyRules must receive the reconciled (ACTIVE) rule.
        expect(filterKodyRules.mock.calls[0][0]).toEqual([unlockedRule]);
    });

    it('passes the free-plan gate through so the sync can enforce the cap', async () => {
        const { service, kodyRulesService } = buildService(true);
        // On free the reconcile no-ops here (returns null); the parked rule
        // flows through unchanged.
        kodyRulesService.syncRulesWithPlanLimit.mockResolvedValue(null);

        await service.getConfig(organizationAndTeamData, repository);

        expect(kodyRulesService.syncRulesWithPlanLimit).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({ limited: true }),
        );
    });
});
