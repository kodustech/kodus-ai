jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock('./utils/enrich-rules-with-context-references.util', () => ({
    enrichRulesWithContextReferences: jest.fn(async (rules) => rules),
}));

import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * This is the endpoint the Kody Rules screen actually renders from
 * (find-rules-in-organization-by-filter). Opening it on a paid plan must
 * self-heal rules parked as PAUSED + lockedByPlan:true so the UI reflects the
 * paid state (rules ACTIVE, no "locked" banner) without waiting for a review.
 */
describe('FindRulesInOrganizationByRuleFilterKodyRulesUseCase — plan unlock', () => {
    const ORG_ID = 'org-1';
    let useCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase;
    let kodyRulesService: {
        find: jest.Mock;
        unlockRulesLockedByPlan: jest.Mock;
    };

    const build = () => {
        kodyRulesService = {
            find: jest.fn(),
            unlockRulesLockedByPlan: jest.fn().mockResolvedValue(null),
        };
        // No request.user → authorization scoping is skipped.
        const request = {};
        const contextReferenceService = {};
        const authorizationService = {};

        useCase = new (FindRulesInOrganizationByRuleFilterKodyRulesUseCase as any)(
            kodyRulesService,
            request,
            contextReferenceService,
            authorizationService,
        );
    };

    beforeEach(build);

    it('unlocks plan-locked rules and returns them ACTIVE on a paid plan', async () => {
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
        kodyRulesService.find.mockResolvedValueOnce([
            { rules: [lockedRule, activeRule] },
        ]);
        // Paid plan → unlock persists and returns a (truthy) refreshed doc.
        kodyRulesService.unlockRulesLockedByPlan.mockResolvedValueOnce({
            toObject: () => ({ rules: [] }),
        });

        const result = (await useCase.execute(ORG_ID, {})) as any[];

        expect(kodyRulesService.unlockRulesLockedByPlan).toHaveBeenCalledTimes(1);
        expect(
            kodyRulesService.unlockRulesLockedByPlan.mock.calls[0][0],
        ).toEqual({ organizationId: ORG_ID });

        const unlockedInResult = result.find((r) => r.uuid === 'r-locked');
        expect(unlockedInResult.status).toBe(KodyRulesStatus.ACTIVE);
        expect(unlockedInResult.lockedByPlan).toBe(false);
    });

    it('does not call unlock when no rule is plan-locked', async () => {
        kodyRulesService.find.mockResolvedValueOnce([
            {
                rules: [
                    { uuid: 'r-active', status: KodyRulesStatus.ACTIVE },
                    { uuid: 'r-paused', status: KodyRulesStatus.PAUSED },
                ],
            },
        ]);

        await useCase.execute(ORG_ID, {});

        expect(kodyRulesService.unlockRulesLockedByPlan).not.toHaveBeenCalled();
    });

    it('keeps rules parked when the unlock no-ops (Free plan)', async () => {
        const lockedRule = {
            uuid: 'r-locked',
            status: KodyRulesStatus.PAUSED,
            lockedByPlan: true,
        };
        kodyRulesService.find.mockResolvedValueOnce([{ rules: [lockedRule] }]);
        // Free plan → unlock returns null, nothing changes.
        kodyRulesService.unlockRulesLockedByPlan.mockResolvedValueOnce(null);

        const result = (await useCase.execute(ORG_ID, {})) as any[];

        const stillLocked = result.find((r) => r.uuid === 'r-locked');
        expect(stillLocked.status).toBe(KodyRulesStatus.PAUSED);
        expect(stillLocked.lockedByPlan).toBe(true);
    });
});
