import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import {
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * The free-plan create gate must count ACTIVE rules only — the same pool the
 * `/limits` endpoint reports. Counting `!== DELETED` (the old behaviour) also
 * counted PAUSED/PENDING rules the UI never showed against the quota, so the
 * UI said "add away" while the backend rejected. This pins the ACTIVE-only
 * count so that regression can't return silently.
 */
describe('KodyRulesService create gate (free-plan limit counts ACTIVE only)', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildService = (existingRules: Array<{ status: KodyRulesStatus }>) => {
        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ uuid: 'kr-1', rules: existingRules }),
            // addRule must return a truthy entity so createOrUpdate doesn't throw.
            addRule: jest.fn().mockResolvedValue({ rules: [] }),
            // updateRule echoes back the rule it was handed so the update
            // path's `.find()` resolves.
            updateRule: jest
                .fn()
                .mockImplementation((_uuid, ruleId, updateData) =>
                    Promise.resolve({
                        rules: [{ ...updateData, uuid: ruleId }],
                    }),
                ),
        };

        // Capture the count handed to the limit validator.
        const validateRulesLimit = jest.fn().mockResolvedValue(true);
        const validationServiceMock = { validateRulesLimit };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            validationServiceMock as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, validateRulesLimit, repositoryMock };
    };

    const newRule = {
        title: 'New rule',
        rule: 'do something',
        path: '**/*',
        severity: 'medium',
        scope: KodyRulesScope.FILE,
        type: KodyRulesType.STANDARD,
    } as any;

    it('counts only ACTIVE existing rules (+1 for the new one)', async () => {
        // 3 ACTIVE + 2 PAUSED. ACTIVE-only → gate sees 3 + 1 = 4.
        const { service, validateRulesLimit } = buildService([
            { status: KodyRulesStatus.ACTIVE },
            { status: KodyRulesStatus.ACTIVE },
            { status: KodyRulesStatus.ACTIVE },
            { status: KodyRulesStatus.PAUSED },
            { status: KodyRulesStatus.PAUSED },
        ]);

        await service.createOrUpdate(organizationAndTeamData, newRule, {
            userId: 'u1',
            userEmail: 'u1@kodus.io',
        } as any);

        expect(validateRulesLimit).toHaveBeenCalledWith(
            organizationAndTeamData,
            4,
        );
        // NOT 6 — paused rules must not consume quota.
        expect(validateRulesLimit).not.toHaveBeenCalledWith(
            organizationAndTeamData,
            6,
        );
    });

    it('ignores PAUSED and PENDING rules entirely in the count', async () => {
        // 1 ACTIVE + 4 non-active → gate sees 1 + 1 = 2.
        const { service, validateRulesLimit } = buildService([
            { status: KodyRulesStatus.ACTIVE },
            { status: KodyRulesStatus.PAUSED },
            { status: KodyRulesStatus.PENDING },
            { status: KodyRulesStatus.PENDING },
            { status: KodyRulesStatus.DELETED },
        ]);

        await service.createOrUpdate(organizationAndTeamData, newRule, {
            userId: 'u1',
            userEmail: 'u1@kodus.io',
        } as any);

        expect(validateRulesLimit).toHaveBeenCalledWith(
            organizationAndTeamData,
            2,
        );
    });

    it('skips the quota check entirely when the new rule is created PAUSED (P4)', async () => {
        // A rule that doesn't land ACTIVE never consumes quota, so
        // resolveStatusWithinPlanLimit short-circuits without calling the
        // validator at all — nothing to gate.
        const { service, validateRulesLimit } = buildService([
            { status: KodyRulesStatus.ACTIVE },
            { status: KodyRulesStatus.ACTIVE },
            { status: KodyRulesStatus.ACTIVE },
        ]);

        await service.createOrUpdate(
            organizationAndTeamData,
            { ...newRule, status: KodyRulesStatus.PAUSED },
            { userId: 'u1', userEmail: 'u1@kodus.io' } as any,
        );

        expect(validateRulesLimit).not.toHaveBeenCalled();
    });
});

/**
 * End-to-end enforcement of the free-plan ceiling THROUGH createOrUpdate, with
 * a validator that applies the real `total <= 10` rule (instead of the
 * always-true mock above). Proves the gate doesn't just compute the right
 * count — it actually rejects, and that PAUSED rules never push a user over.
 */
describe('KodyRulesService create gate enforces the 10-rule ceiling', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const MAX = 10;

    // A validator mirroring KodyRulesValidationService with limiting ON:
    // allowed only while the post-operation total stays within MAX.
    const buildEnforcingService = (
        existingRules: Array<{ status: KodyRulesStatus }>,
    ) => {
        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ uuid: 'kr-1', rules: existingRules }),
            addRule: jest.fn().mockResolvedValue({ rules: [] }),
        };

        const validateRulesLimit = jest
            .fn()
            .mockImplementation((_org, total: number) =>
                Promise.resolve(total <= MAX),
            );

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { validateRulesLimit } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, repositoryMock };
    };

    const activeRules = (n: number) =>
        Array.from({ length: n }, () => ({ status: KodyRulesStatus.ACTIVE }));

    const newRule = {
        title: 'New rule',
        rule: 'do something',
        path: '**/*',
        severity: 'medium',
        scope: KodyRulesScope.FILE,
        type: KodyRulesType.STANDARD,
    } as any;

    const userInfo = { userId: 'u1', userEmail: 'u1@kodus.io' } as any;

    it('allows creating the 10th rule (9 active + 1 = 10)', async () => {
        const { service, repositoryMock } = buildEnforcingService(
            activeRules(9),
        );

        // Throws if the gate blocks — reaching addRule means it passed.
        await service.createOrUpdate(organizationAndTeamData, newRule, userInfo);
        expect(repositoryMock.addRule).toHaveBeenCalled();
    });

    it('creates the 11th rule PAUSED+lockedByPlan instead of rejecting it', async () => {
        const { service, repositoryMock } = buildEnforcingService(
            activeRules(10),
        );

        // No longer throws — the rule is still persisted, just locked
        // (same "value-forward" pattern as MCP plugins beyond their cap).
        await service.createOrUpdate(organizationAndTeamData, newRule, userInfo);

        expect(repositoryMock.addRule).toHaveBeenCalled();
        const [, persistedRule] = repositoryMock.addRule.mock.calls[0];
        expect(persistedRule.status).toBe(KodyRulesStatus.PAUSED);
        expect(persistedRule.lockedByPlan).toBe(true);
    });

    it('does NOT count PAUSED rules toward the ceiling (9 active + 20 paused + 1 = 10, allowed)', async () => {
        const { service, repositoryMock } = buildEnforcingService([
            ...activeRules(9),
            ...Array.from({ length: 20 }, () => ({
                status: KodyRulesStatus.PAUSED,
            })),
        ]);

        // Old `!== DELETED` logic would have counted 29 + 1 = 30 → blocked.
        // ACTIVE-only sees 9 + 1 = 10 → allowed.
        await service.createOrUpdate(organizationAndTeamData, newRule, userInfo);
        expect(repositoryMock.addRule).toHaveBeenCalled();
    });

    it('lets a new PAUSED rule through even at 10 active (it does not consume quota — P4)', async () => {
        const { service, repositoryMock } = buildEnforcingService(
            activeRules(10),
        );

        // 10 active + a new PAUSED rule → 10 + 0 = 10 → allowed.
        await service.createOrUpdate(
            organizationAndTeamData,
            { ...newRule, status: KodyRulesStatus.PAUSED },
            userInfo,
        );
        expect(repositoryMock.addRule).toHaveBeenCalled();
    });

    it('locks the rule (fail closed) instead of throwing when the validator itself errors', async () => {
        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ uuid: 'kr-1', rules: activeRules(3) }),
            addRule: jest.fn().mockResolvedValue({ rules: [] }),
        };
        const validateRulesLimit = jest
            .fn()
            .mockRejectedValue(new Error('billing service unreachable'));
        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { validateRulesLimit } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        // Must not reject the request — same fail-closed outcome as hitting
        // the cap (locked), not a 500 surfaced to the caller.
        await expect(
            service.createOrUpdate(organizationAndTeamData, newRule, userInfo),
        ).resolves.not.toThrow();

        const [, persistedRule] = repositoryMock.addRule.mock.calls[0];
        expect(persistedRule.status).toBe(KodyRulesStatus.PAUSED);
        expect(persistedRule.lockedByPlan).toBe(true);
    });

    it('never throws across a batch of creates past the cap — proves IDE-sync/import loops no longer abort mid-batch', async () => {
        // Regression guard for the behavior change: before this redesign,
        // every one of these 5 calls beyond the 10-rule cap would have
        // thrown BadRequestException, which is exactly what aborted
        // sync-ide-rules/resync-ide-rules mid-repository and silently
        // dropped rules in import-fast-ide-rules. Simulates the org
        // starting at the cap (10 active) and repeatedly creating more
        // "new rule" calls, as a sync loop would.
        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ uuid: 'kr-1', rules: activeRules(10) }),
            addRule: jest.fn().mockResolvedValue({ rules: [] }),
        };
        const validateRulesLimit = jest
            .fn()
            .mockImplementation((_org, total: number) =>
                Promise.resolve(total <= MAX),
            );
        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { validateRulesLimit } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        for (let i = 0; i < 5; i++) {
            await expect(
                service.createOrUpdate(
                    organizationAndTeamData,
                    { ...newRule, title: `Synced rule ${i}` },
                    userInfo,
                ),
            ).resolves.not.toThrow();
        }

        expect(repositoryMock.addRule).toHaveBeenCalledTimes(5);
        for (const call of repositoryMock.addRule.mock.calls) {
            expect(call[1].status).toBe(KodyRulesStatus.PAUSED);
            expect(call[1].lockedByPlan).toBe(true);
        }
    });
});

describe('KodyRulesService.createOrUpdate severity normalization on update (P3)', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    it('lower-cases severity when updating an existing rule', async () => {
        const updateRule = jest
            .fn()
            .mockImplementation((_uuid, ruleId, updateData) =>
                Promise.resolve({ rules: [{ ...updateData, uuid: ruleId }] }),
            );
        const repositoryMock = {
            findByOrganizationId: jest.fn().mockResolvedValue({
                uuid: 'kr-1',
                rules: [
                    {
                        uuid: 'rule-1',
                        title: 'Old',
                        severity: 'low',
                        status: KodyRulesStatus.ACTIVE,
                    },
                ],
            }),
            updateRule,
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        await service.createOrUpdate(
            organizationAndTeamData,
            { uuid: 'rule-1', severity: 'Critical' } as any,
            { userId: 'u1', userEmail: 'u1@kodus.io' } as any,
        );

        const [, , updateData] = updateRule.mock.calls[0];
        expect(updateData.severity).toBe('critical');
    });
});
