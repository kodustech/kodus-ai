import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

// EE services pull `@libs/ee/configs/environment`, which is gitignored (copied
// from environment.dev.ts for local builds) — mock it so the suite runs anywhere.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false, API_DEVELOPMENT_MODE: false },
}));

import { KodyRulesService } from './kodyRules.service';

/**
 * syncRulesWithPlanLimit is the plan-limit enforcement gate for Kody Rules — the
 * billing-critical decision that pauses a FREE org's rules past the ceiling and
 * un-pauses a paid org's plan-locked rules. A regression either lets a FREE org
 * run unlimited rules (revenue leak) or silently drops a paying customer's rules.
 * The repo/license deps are stubbed; these pin the decision, not the I/O.
 */
describe('KodyRulesService.syncRulesWithPlanLimit — plan-limit enforcement', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
    const MAX = 10;

    let repo: { findByOrganizationId: jest.Mock; updateRule: jest.Mock };
    let permission: { shouldLimitResources: jest.Mock };
    let svc: KodyRulesService;

    const entityOf = (rules: any[]) => ({
        uuid: 'doc-1',
        toObject: () => ({ rules }),
    });

    const rule = (i: number, over: Record<string, unknown> = {}) => ({
        uuid: `r${i}`,
        status: KodyRulesStatus.ACTIVE,
        lockedByPlan: false,
        ...over,
    });

    beforeEach(() => {
        repo = {
            findByOrganizationId: jest.fn().mockResolvedValue(null),
            updateRule: jest.fn().mockResolvedValue(true),
        };
        permission = { shouldLimitResources: jest.fn() };
        svc = new KodyRulesService(
            repo as any, // 1 kodyRulesRepository
            {} as any, // 2 eventEmitter
            {} as any, // 3 ruleLikeService
            {} as any, // 4 pullRequestsRepository
            { MAX_KODY_RULES: MAX } as any, // 5 kodyRulesValidationService
            {} as any, // 6 mcpManagerService
            {} as any, // 7 observabilityService
            permission as any, // 8 permissionValidationService
            {} as any, // 9 moduleRef
            {} as any, // 10 codeBaseConfigService
            undefined, // 11 kodyRuleSummaryService (optional)
        );
        jest.spyOn((svc as any).logger, 'log').mockImplementation(() => {});
        jest.spyOn((svc as any).logger, 'error').mockImplementation(() => {});
    });

    it('returns null when there is no organization id', async () => {
        expect(await svc.syncRulesWithPlanLimit({} as any)).toBeNull();
    });

    it('returns the entity untouched (no writes) when it has no rules', async () => {
        const entity = entityOf([]);
        const out = await svc.syncRulesWithPlanLimit(ORG, {
            entity: entity as any,
            limited: true,
        });
        expect(out).toBe(entity);
        expect(repo.updateRule).not.toHaveBeenCalled();
    });

    it('FREE plan: pauses ONLY the active rules beyond the 10-rule ceiling, locked by plan', async () => {
        const rules = Array.from({ length: 12 }, (_, i) => rule(i + 1));
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf(rules) as any,
            limited: true,
        });

        expect(repo.updateRule).toHaveBeenCalledTimes(2); // only #11 and #12
        expect(repo.updateRule).toHaveBeenCalledWith(
            'doc-1',
            'r11',
            expect.objectContaining({
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            }),
        );
        expect(repo.updateRule).toHaveBeenCalledWith(
            'doc-1',
            'r12',
            expect.objectContaining({
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            }),
        );
    });

    it('FREE plan: exactly 10 active rules is within the ceiling — no changes', async () => {
        const entity = entityOf(Array.from({ length: MAX }, (_, i) => rule(i + 1)));
        const out = await svc.syncRulesWithPlanLimit(ORG, {
            entity: entity as any,
            limited: true,
        });
        expect(repo.updateRule).not.toHaveBeenCalled();
        expect(out).toBe(entity);
    });

    it('PAID plan: un-pauses plan-locked rules but leaves manually-paused ones alone', async () => {
        const rules = [
            rule(1, { status: KodyRulesStatus.PAUSED, lockedByPlan: true }), // plan-locked → unpause
            rule(2, { status: KodyRulesStatus.PAUSED, lockedByPlan: false }), // manual pause → leave
            rule(3), // active → leave
        ];
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf(rules) as any,
            limited: false,
        });

        expect(repo.updateRule).toHaveBeenCalledTimes(1); // only the plan-locked one
        expect(repo.updateRule).toHaveBeenCalledWith(
            'doc-1',
            'r1',
            expect.objectContaining({
                status: KodyRulesStatus.ACTIVE,
                lockedByPlan: false,
            }),
        );
    });

    it('reuses the caller-provided `limited` flag instead of a second license lookup', async () => {
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf([rule(1)]) as any,
            limited: false,
        });
        expect(permission.shouldLimitResources).not.toHaveBeenCalled();
    });

    it('falls back to shouldLimitResources when `limited` is not provided', async () => {
        permission.shouldLimitResources.mockResolvedValue(false);
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf([
                rule(1, { status: KodyRulesStatus.PAUSED, lockedByPlan: true }),
            ]) as any,
        });
        expect(permission.shouldLimitResources).toHaveBeenCalled();
        expect(repo.updateRule).toHaveBeenCalledTimes(1); // paid → unpaused
    });

    it('loads the rules doc itself when the caller does not pass the entity', async () => {
        repo.findByOrganizationId.mockResolvedValue(
            entityOf([
                rule(1, { status: KodyRulesStatus.PAUSED, lockedByPlan: true }),
            ]),
        );
        await svc.syncRulesWithPlanLimit(ORG, { limited: false });
        expect(repo.findByOrganizationId).toHaveBeenCalledWith('org-1');
        expect(repo.updateRule).toHaveBeenCalledTimes(1);
    });

    it('is fail-safe when the limit check throws — returns the entity, changes nothing', async () => {
        permission.shouldLimitResources.mockRejectedValue(
            new Error('license service down'),
        );
        const entity = entityOf([rule(1)]);
        const out = await svc.syncRulesWithPlanLimit(ORG, {
            entity: entity as any,
        }); // no `limited` → forces the lookup that throws
        expect(out).toBe(entity);
        expect(repo.updateRule).not.toHaveBeenCalled();
    });

    it('is fail-safe when a per-rule update rejects — it never throws, and logs the failure', async () => {
        repo.updateRule.mockRejectedValue(new Error('mongo write failed'));
        const rules = Array.from({ length: 12 }, (_, i) => rule(i + 1));
        // Promise.allSettled means the rejections are logged, not thrown.
        await svc.syncRulesWithPlanLimit(ORG, {
            entity: entityOf(rules) as any,
            limited: true,
        });
        expect((svc as any).logger.error).toHaveBeenCalled();
    });
});
