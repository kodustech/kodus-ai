import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * When an org upgrades from Free to a paid plan the rule quota disappears, but
 * the rules that were parked as `PAUSED` + `lockedByPlan: true` while on Free
 * stayed parked — the review kept ignoring them forever. `unlockRulesLockedByPlan`
 * reconciles that lazily: on a paid plan every plan-locked rule flips back to
 * ACTIVE. Manual pauses (`lockedByPlan` false/absent) must never be touched.
 */
describe('KodyRulesService.unlockRulesLockedByPlan', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildService = (opts?: {
        limited?: boolean;
        unlockResult?: any;
    }) => {
        const bulkUnlockPlanLockedRules = jest
            .fn()
            .mockResolvedValue(opts?.unlockResult ?? null);
        const repositoryMock = { bulkUnlockPlanLockedRules };

        const shouldLimitResources = jest
            .fn()
            .mockResolvedValue(opts?.limited ?? false);
        const permissionValidationServiceMock = { shouldLimitResources };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            permissionValidationServiceMock as any,
            {} as any,
            {} as any,
        );

        return {
            service,
            bulkUnlockPlanLockedRules,
            shouldLimitResources,
        };
    };

    const lockedRule = {
        uuid: 'r-locked',
        status: KodyRulesStatus.PAUSED,
        lockedByPlan: true,
    };
    const activeRule = {
        uuid: 'r-active',
        status: KodyRulesStatus.ACTIVE,
        lockedByPlan: false,
    };

    it('unlocks plan-locked rules on a paid plan (limited=false)', async () => {
        const unlockedEntity = {
            toObject: () => ({
                rules: [
                    activeRule,
                    { ...lockedRule, status: KodyRulesStatus.ACTIVE, lockedByPlan: false },
                ],
            }),
        };
        const { service, bulkUnlockPlanLockedRules, shouldLimitResources } =
            buildService({ limited: false, unlockResult: unlockedEntity });

        const result = await service.unlockRulesLockedByPlan(
            organizationAndTeamData,
            { rules: [activeRule, lockedRule] },
        );

        expect(shouldLimitResources).toHaveBeenCalled();
        expect(bulkUnlockPlanLockedRules).toHaveBeenCalledWith('org-1');
        expect(result).toBe(unlockedEntity);
    });

    it('reuses a caller-supplied `limited` and skips the plan lookup', async () => {
        const { service, bulkUnlockPlanLockedRules, shouldLimitResources } =
            buildService();

        await service.unlockRulesLockedByPlan(organizationAndTeamData, {
            limited: false,
            rules: [lockedRule],
        });

        expect(shouldLimitResources).not.toHaveBeenCalled();
        expect(bulkUnlockPlanLockedRules).toHaveBeenCalledWith('org-1');
    });

    it('is a no-op on a still-limited (Free) plan', async () => {
        const { service, bulkUnlockPlanLockedRules } = buildService();

        const result = await service.unlockRulesLockedByPlan(
            organizationAndTeamData,
            { limited: true, rules: [lockedRule] },
        );

        expect(result).toBeNull();
        expect(bulkUnlockPlanLockedRules).not.toHaveBeenCalled();
    });

    it('short-circuits (no plan lookup, no write) when nothing is plan-locked', async () => {
        const { service, bulkUnlockPlanLockedRules, shouldLimitResources } =
            buildService();

        const result = await service.unlockRulesLockedByPlan(
            organizationAndTeamData,
            { rules: [activeRule] },
        );

        expect(result).toBeNull();
        expect(shouldLimitResources).not.toHaveBeenCalled();
        expect(bulkUnlockPlanLockedRules).not.toHaveBeenCalled();
    });

    it('fails open (returns null) when the bulk update throws', async () => {
        const { service, bulkUnlockPlanLockedRules } = buildService();
        bulkUnlockPlanLockedRules.mockRejectedValueOnce(new Error('mongo down'));

        const result = await service.unlockRulesLockedByPlan(
            organizationAndTeamData,
            { limited: false, rules: [lockedRule] },
        );

        expect(result).toBeNull();
    });
});
