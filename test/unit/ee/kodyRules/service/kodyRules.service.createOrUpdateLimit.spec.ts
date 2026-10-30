import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import { KodyRulesEntity } from '@libs/kodyRules/domain/entities/kodyRules.entity';
import {
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
    IKodyRule,
    IKodyRuleContextNeed,
    IKodyRuleFileScope,
    IKodyRules,
    KodyRulesOrigin,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';

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

describe('KodyRulesService.syncRulesWithPlanLimit & self-healing read path', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    it('triggers syncRulesWithPlanLimit from find() when stale PAUSED+lockedByPlan rules exist on a paid org', async () => {
        const existingRules = [
            {
                uuid: 'r1',
                title: 'Stale locked rule 1',
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            },
            {
                uuid: 'r2',
                title: 'Stale locked rule 2',
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            },
        ];

        let currentEntity = KodyRulesEntity.create({ uuid: 'kr-1', organizationId: 'org-1', rules: existingRules });

        const repositoryMock = {
            find: jest.fn().mockImplementation(() => Promise.resolve([currentEntity])),
            findByOrganizationId: jest.fn().mockImplementation(() => Promise.resolve(currentEntity)),
            update: jest.fn().mockImplementation((_uuid, updateData) => {
                currentEntity = KodyRulesEntity.create({ ...currentEntity.toObject(), ...updateData });
                return Promise.resolve(currentEntity);
            }),
            updateRule: jest.fn().mockImplementation((_uuid, ruleId, patch) => {
                const rules = currentEntity.toObject().rules.map((r) =>
                    r.uuid === ruleId ? { ...r, ...patch } : r,
                );
                currentEntity = KodyRulesEntity.create({
                    ...currentEntity.toObject(),
                    rules,
                });
                return Promise.resolve(currentEntity);
            }),
        };

        const permissionValidationServiceMock = {
            shouldLimitResources: jest.fn().mockResolvedValue(false), // Paid plan!
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { validateRulesLimit: jest.fn() } as any,
            {} as any,
            {} as any,
            permissionValidationServiceMock as any,
            {} as any,
            {} as any,
        );

        // find() triggers background sync, but the returned entity has severity-normalized rules
        const results = await service.find({ organizationId: 'org-1' });
        expect(results).toHaveLength(1);

        // Wait briefly for the background syncRulesWithPlanLimit to complete
        await new Promise((r) => setTimeout(r, 100));

        // Check that repository.updateRule was called to persist updated active rules to MongoDB
        expect(repositoryMock.updateRule).toHaveBeenCalled();
        const updatedRules = currentEntity.toObject().rules;

        // r1 and r2 flipped to ACTIVE & lockedByPlan: false
        expect(updatedRules[0].status).toBe(KodyRulesStatus.ACTIVE);
        expect(updatedRules[0].lockedByPlan).toBe(false);
        expect(updatedRules[1].status).toBe(KodyRulesStatus.ACTIVE);
        expect(updatedRules[1].lockedByPlan).toBe(false);
    });

    // The review pipeline (codeBaseConfig) already holds the entity and the
    // resolved plan gate, so it passes them in to avoid duplicate lookups.
    it('reuses caller-supplied entity + limited without re-loading or re-checking the plan', async () => {
        const existingRules = [
            {
                uuid: 'r1',
                title: 'Locked',
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            },
        ];
        let currentEntity = KodyRulesEntity.create({
            uuid: 'kr-1',
            organizationId: 'org-1',
            rules: existingRules,
        });

        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockImplementation(() => Promise.resolve(currentEntity)),
            updateRule: jest.fn().mockImplementation((_uuid, ruleId, patch) => {
                const rules = currentEntity
                    .toObject()
                    .rules.map((r) =>
                        r.uuid === ruleId ? { ...r, ...patch } : r,
                    );
                currentEntity = KodyRulesEntity.create({
                    ...currentEntity.toObject(),
                    rules,
                });
                return Promise.resolve(currentEntity);
            }),
        };
        const permissionValidationServiceMock = {
            shouldLimitResources: jest.fn().mockResolvedValue(true),
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { MAX_KODY_RULES: 10 } as any,
            {} as any,
            {} as any,
            permissionValidationServiceMock as any,
            {} as any,
            {} as any,
        );

        await service.syncRulesWithPlanLimit(organizationAndTeamData, {
            entity: currentEntity,
            limited: false,
        });

        // `limited` reused → no license lookup.
        expect(
            permissionValidationServiceMock.shouldLimitResources,
        ).not.toHaveBeenCalled();
        // Initial load skipped (entity reused); findByOrganizationId only runs
        // once, for the fresh re-fetch after the write.
        expect(repositoryMock.findByOrganizationId).toHaveBeenCalledTimes(1);
        // Still reconciles: the plan-locked rule is reactivated.
        expect(repositoryMock.updateRule).toHaveBeenCalled();
        expect(currentEntity.toObject().rules[0].status).toBe(
            KodyRulesStatus.ACTIVE,
        );
        expect(currentEntity.toObject().rules[0].lockedByPlan).toBe(false);
    });

    it('is a zero-lookup no-op when the passed rules already match the plan', async () => {
        const entity = KodyRulesEntity.create({
            uuid: 'kr-1',
            organizationId: 'org-1',
            rules: [
                {
                    uuid: 'r1',
                    status: KodyRulesStatus.ACTIVE,
                    lockedByPlan: false,
                },
            ],
        });

        const repositoryMock = {
            findByOrganizationId: jest.fn(),
            updateRule: jest.fn(),
        };
        const permissionValidationServiceMock = {
            shouldLimitResources: jest.fn(),
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { MAX_KODY_RULES: 10 } as any,
            {} as any,
            {} as any,
            permissionValidationServiceMock as any,
            {} as any,
            {} as any,
        );

        // Paid plan, nothing locked → nothing to do, and it must not touch the
        // DB or the license service (the common per-review path).
        await service.syncRulesWithPlanLimit(organizationAndTeamData, {
            entity,
            limited: false,
        });

        expect(repositoryMock.findByOrganizationId).not.toHaveBeenCalled();
        expect(
            permissionValidationServiceMock.shouldLimitResources,
        ).not.toHaveBeenCalled();
        expect(repositoryMock.updateRule).not.toHaveBeenCalled();
    });
});

/**
 * Persistence of the declared context need (issue #1826). Derived from
 * spec.md's P2 story:
 *   KRC-10  the rule stores a `contextNeed`
 *   KRC-11  an author's value is used instead of the inferred one
 *
 * The failure mode this guards is silent, not loud: `createOrUpdate` builds a
 * new rule by mapping every field explicitly, so a field missing from one of
 * those literals is dropped at birth with no error anywhere — and the next
 * review then judges the rule as `diff-only`, which looks exactly like a
 * working rule.
 */
describe('KodyRulesService — contextNeed persistence', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const compilerNeed: IKodyRuleContextNeed = {
        need: 'symbol-references',
        sourceHash: 'hash-of-original-body',
        source: 'compiler',
        inferredAt: new Date('2026-09-01T00:00:00Z'),
        model: 'kimi-k2.7',
    };

    const authorNeed: IKodyRuleContextNeed = {
        need: 'sibling-file',
        sourceHash: 'hash-of-original-body',
        source: 'author',
        inferredAt: new Date('2026-09-02T00:00:00Z'),
    };

    const storedRule = (over: Partial<IKodyRule> = {}): IKodyRule =>
        ({
            uuid: 'rule-1',
            type: KodyRulesType.STANDARD,
            title: 'Original title',
            rule: 'original body text',
            path: '**/*.ts',
            severity: 'high',
            status: KodyRulesStatus.ACTIVE,
            repositoryId: 'repo-1',
            scope: KodyRulesScope.FILE,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
            ...over,
        }) as IKodyRule;

    const buildService = (rules: IKodyRule[]) => {
        const updateRule = jest
            .fn()
            .mockImplementation((_uuid, ruleId, updateData) =>
                Promise.resolve({ rules: [{ ...updateData, uuid: ruleId }] }),
            );
        const addRule = jest
            .fn()
            .mockImplementation((_uuid, rule) =>
                Promise.resolve({ rules: [rule] }),
            );
        const create = jest
            .fn()
            .mockImplementation((doc) => Promise.resolve(doc));

        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue(
                    rules.length ? { uuid: 'kr-doc-1', rules } : null,
                ),
            updateRule,
            addRule,
            create,
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any, // eventEmitter
            {} as any, // ruleLikeService
            {} as any, // pullRequestsRepository
            { validateRulesLimit: jest.fn().mockResolvedValue(true) } as any,
            {} as any, // mcpManagerService
            {} as any, // observabilityService
            {} as any, // permissionValidationService
            {} as any, // moduleRef
            {} as any, // codeBaseConfigService
        );

        // ensureRepositoryCodeReviewConfig reaches for parameters services the
        // create path does not otherwise need here.
        jest.spyOn(
            service as any,
            'ensureRepositoryCodeReviewConfig',
        ).mockResolvedValue(undefined);

        return { service, updateRule, addRule, create };
    };

    const userInfo = { userId: 'u1', userEmail: 'u1@kodus.io' } as any;
    const capturedUpdate = (updateRule: jest.Mock) =>
        updateRule.mock.calls[0][2];

    describe('createOrUpdate', () => {
        it('preserves an existing contextNeed across an unrelated edit', async () => {
            const { service, updateRule } = buildService([
                storedRule({ contextNeed: compilerNeed }),
            ]);

            await service.createOrUpdate(
                organizationAndTeamData,
                { uuid: 'rule-1', status: KodyRulesStatus.PAUSED } as any,
                userInfo,
            );

            const update = capturedUpdate(updateRule);
            expect(update.status).toBe(KodyRulesStatus.PAUSED);
            expect(update.contextNeed).toEqual(compilerNeed);
        });

        it('preserves an existing contextNeed when the rule text is edited', async () => {
            // A text edit invalidates the inference by HASH at read time; it
            // must not silently erase the record, which would also erase an
            // author's value.
            const { service, updateRule } = buildService([
                storedRule({ contextNeed: authorNeed }),
            ]);

            await service.createOrUpdate(
                organizationAndTeamData,
                { uuid: 'rule-1', rule: 'a totally new body' } as any,
                userInfo,
            );

            const update = capturedUpdate(updateRule);
            expect(update.rule).toBe('a totally new body');
            expect(update.contextNeed).toEqual(authorNeed);
        });

        it('carries an author-supplied contextNeed onto a rule created in an existing document', async () => {
            const { service, addRule } = buildService([storedRule()]);

            await service.createOrUpdate(
                organizationAndTeamData,
                {
                    title: 'New rule',
                    rule: 'body',
                    severity: 'high',
                    repositoryId: 'repo-1',
                    contextNeed: authorNeed,
                } as any,
                userInfo,
            );

            expect(addRule.mock.calls[0][1].contextNeed).toEqual(authorNeed);
        });

        it('carries an author-supplied contextNeed onto the first rule of a new document', async () => {
            const { service, create } = buildService([]);

            await service.createOrUpdate(
                organizationAndTeamData,
                {
                    title: 'New rule',
                    rule: 'body',
                    severity: 'high',
                    repositoryId: 'repo-1',
                    contextNeed: authorNeed,
                } as any,
                userInfo,
            );

            expect(create.mock.calls[0][0].rules[0].contextNeed).toEqual(
                authorNeed,
            );
        });
    });

    describe('updateRuleContextNeed', () => {
        it('writes the inferred need onto the rule', async () => {
            const { service, updateRule } = buildService([storedRule()]);

            const out = await service.updateRuleContextNeed(
                'org-1',
                'rule-1',
                compilerNeed,
            );

            expect(capturedUpdate(updateRule).contextNeed).toEqual(
                compilerNeed,
            );
            expect(out?.contextNeed).toEqual(compilerNeed);
        });

        it('leaves every other field of the rule untouched', async () => {
            const { service, updateRule } = buildService([storedRule()]);

            await service.updateRuleContextNeed(
                'org-1',
                'rule-1',
                compilerNeed,
            );

            const update = capturedUpdate(updateRule);
            expect(update.title).toBe('Original title');
            expect(update.rule).toBe('original body text');
            expect(update.status).toBe(KodyRulesStatus.ACTIVE);
        });

        it('passes null through so a stale need is actually cleared', async () => {
            const { service, updateRule } = buildService([
                storedRule({ contextNeed: compilerNeed }),
            ]);

            await service.updateRuleContextNeed('org-1', 'rule-1', null);

            // `null`, not `undefined` — the repository skips undefined, so an
            // undefined here would leave the stale need in place forever.
            expect(capturedUpdate(updateRule).contextNeed).toBeNull();
        });

        it('never overwrites an author-set need with an inferred one (KRC-11)', async () => {
            const { service, updateRule } = buildService([
                storedRule({ contextNeed: authorNeed }),
            ]);

            const out = await service.updateRuleContextNeed(
                'org-1',
                'rule-1',
                compilerNeed,
            );

            expect(updateRule).not.toHaveBeenCalled();
            expect(out?.contextNeed).toEqual(authorNeed);
        });

        it('never clears an author-set need on a compiler-driven clear', async () => {
            const { service, updateRule } = buildService([
                storedRule({ contextNeed: authorNeed }),
            ]);

            await service.updateRuleContextNeed('org-1', 'rule-1', null);

            expect(updateRule).not.toHaveBeenCalled();
        });

        it('lets an author replace their own value', async () => {
            const { service, updateRule } = buildService([
                storedRule({ contextNeed: authorNeed }),
            ]);
            const replacement: IKodyRuleContextNeed = {
                ...authorNeed,
                need: 'sibling-file',
            };

            await service.updateRuleContextNeed(
                'org-1',
                'rule-1',
                replacement,
            );

            expect(capturedUpdate(updateRule).contextNeed).toEqual(
                replacement,
            );
        });

        it('raises when the rule does not exist', async () => {
            const { service } = buildService([storedRule()]);

            await expect(
                service.updateRuleContextNeed('org-1', 'nope', compilerNeed),
            ).rejects.toThrow('Rule not found');
        });
    });

    /**
     * The same silent failure, one field over. `fileScope` REMOVES files from
     * review, so losing it un-narrows a rule and losing it the other way
     * (keeping a stale one) stops enforcing it — both are invisible to the
     * customer, which is why they are pinned here and not left to the compiler
     * service's own tests.
     */
    describe('fileScope persistence', () => {
        const compilerScope: IKodyRuleFileScope = {
            extensions: ['.rb', '.rake'],
            sourceHash: 'hash-of-original-body',
            source: 'compiler',
            inferredAt: new Date('2026-09-01T00:00:00Z'),
            model: 'kimi-k2.7',
        };

        const authorScope: IKodyRuleFileScope = {
            extensions: ['.rb'],
            sourceHash: 'hash-of-original-body',
            source: 'author',
            inferredAt: new Date('2026-09-02T00:00:00Z'),
        };

        it('preserves an existing fileScope across an unrelated edit', async () => {
            const { service, updateRule } = buildService([
                storedRule({ fileScope: compilerScope }),
            ]);

            await service.createOrUpdate(
                organizationAndTeamData,
                {
                    uuid: 'rule-1',
                    title: 'A new title',
                    rule: 'original body text',
                    path: '**/*.ts',
                    severity: 'high',
                    repositoryId: 'repo-1',
                } as any,
                userInfo,
            );

            expect(capturedUpdate(updateRule).fileScope).toEqual(compilerScope);
        });

        it('carries an author-supplied scope onto a rule created in an existing document', async () => {
            const { service, addRule } = buildService([storedRule()]);

            await service.createOrUpdate(
                organizationAndTeamData,
                {
                    title: 'New rule',
                    rule: 'body',
                    severity: 'high',
                    repositoryId: 'repo-1',
                    fileScope: authorScope,
                } as any,
                userInfo,
            );

            expect(addRule.mock.calls[0][1].fileScope).toEqual(authorScope);
        });

        it('carries an author-supplied scope onto the first rule of a new document', async () => {
            const { service, create } = buildService([]);

            await service.createOrUpdate(
                organizationAndTeamData,
                {
                    title: 'New rule',
                    rule: 'body',
                    severity: 'high',
                    repositoryId: 'repo-1',
                    fileScope: authorScope,
                } as any,
                userInfo,
            );

            expect(create.mock.calls[0][0].rules[0].fileScope).toEqual(
                authorScope,
            );
        });

        it('stores a compiler-inferred scope', async () => {
            const { service, updateRule } = buildService([storedRule()]);

            await service.updateRuleFileScope(
                'org-1',
                'rule-1',
                compilerScope,
            );

            expect(capturedUpdate(updateRule).fileScope).toEqual(compilerScope);
        });

        it('clears a stale scope when passed null', async () => {
            const { service, updateRule } = buildService([
                storedRule({ fileScope: compilerScope }),
            ]);

            await service.updateRuleFileScope('org-1', 'rule-1', null);

            // `null`, not `undefined`: updateRule skips undefined, so a rule
            // edited to drop its language would keep a narrowing forever.
            expect(capturedUpdate(updateRule).fileScope).toBeNull();
        });

        it('never overwrites an author-set scope with an inferred one', async () => {
            const { service, updateRule } = buildService([
                storedRule({ fileScope: authorScope }),
            ]);

            await service.updateRuleFileScope(
                'org-1',
                'rule-1',
                compilerScope,
            );

            expect(updateRule).not.toHaveBeenCalled();
        });

        it('never clears an author-set scope on a compiler-driven clear', async () => {
            const { service, updateRule } = buildService([
                storedRule({ fileScope: authorScope }),
            ]);

            await service.updateRuleFileScope('org-1', 'rule-1', null);

            expect(updateRule).not.toHaveBeenCalled();
        });

        it('lets an author replace their own value', async () => {
            const { service, updateRule } = buildService([
                storedRule({ fileScope: authorScope }),
            ]);
            const replacement: IKodyRuleFileScope = {
                ...authorScope,
                extensions: ['.rb', '.erb'],
            };

            await service.updateRuleFileScope('org-1', 'rule-1', replacement);

            expect(capturedUpdate(updateRule).fileScope).toEqual(replacement);
        });

        it('raises when the rule does not exist', async () => {
            const { service } = buildService([storedRule()]);

            await expect(
                service.updateRuleFileScope('org-1', 'nope', compilerScope),
            ).rejects.toThrow('Rule not found');
        });
    });
});

describe('KodyRulesService.findMemories', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const createMemoryRule = (overrides: Partial<IKodyRule>): IKodyRule => ({
        uuid: overrides.uuid || Math.random().toString(36),
        type: KodyRulesType.MEMORY,
        title: overrides.title || 'Memory title',
        rule: overrides.rule || 'Memory rule',
        status: overrides.status || KodyRulesStatus.ACTIVE,
        repositoryId: overrides.repositoryId || 'global',
        directoryId: overrides.directoryId,
        path: overrides.path,
        severity: 'medium',
        createdAt: overrides.createdAt || new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: overrides.updatedAt || new Date('2026-01-01T00:00:00.000Z'),
        inheritance: overrides.inheritance || {
            inheritable: true,
            include: [],
            exclude: [],
        },
    });

    const setup = (rules: IKodyRule[]) => {
        const repositoryMock = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ rules } as unknown as IKodyRules),
        };

        const validationService = new KodyRulesValidationService({} as any);

        const service = new KodyRulesService(
            repositoryMock as any,
            { registerKodyRulesLog: jest.fn() } as any,
            {} as any,
            {} as any,
            validationService,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, repositoryMock };
    };

    it('applies inheritance semantics when retrieving memories', async () => {
        const globalMemory = createMemoryRule({
            uuid: 'global-memory',
            repositoryId: 'global',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const excludedByInheritable = createMemoryRule({
            uuid: 'repo-not-inheritable',
            repositoryId: 'repo-1',
            inheritance: {
                inheritable: false,
                include: [],
                exclude: [],
            },
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const excludedByDirectory = createMemoryRule({
            uuid: 'repo-excluded-dir',
            repositoryId: 'repo-1',
            inheritance: {
                inheritable: true,
                include: [],
                exclude: ['dir-1'],
            },
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const directoryMemory = createMemoryRule({
            uuid: 'directory-memory',
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
            createdAt: new Date('2026-01-04T00:00:00.000Z'),
        });

        const { service } = setup([
            globalMemory,
            excludedByInheritable,
            excludedByDirectory,
            directoryMemory,
        ]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'directory-memory',
            'global-memory',
        ]);
    });

    it('ignores directoryId filter when repositoryId is not provided', async () => {
        const globalMemory = createMemoryRule({
            uuid: 'global-memory',
            repositoryId: 'global',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const directoryMemory = createMemoryRule({
            uuid: 'directory-memory',
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const otherDirectoryMemory = createMemoryRule({
            uuid: 'other-directory-memory',
            repositoryId: 'repo-1',
            directoryId: 'dir-2',
            createdAt: new Date('2026-01-04T00:00:00.000Z'),
        });

        const { service } = setup([
            globalMemory,
            directoryMemory,
            otherDirectoryMemory,
        ]);

        const result = await service.findMemories(organizationAndTeamData, {
            directoryId: 'dir-1',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'other-directory-memory',
            'directory-memory',
            'global-memory',
        ]);
    });

    it('includes pathless memories when path filter is provided', async () => {
        const pathlessMemory = createMemoryRule({
            uuid: 'pathless-memory',
            repositoryId: 'repo-1',
            path: undefined,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const matchingPathMemory = createMemoryRule({
            uuid: 'matching-path-memory',
            repositoryId: 'repo-1',
            path: 'src/**',
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const nonMatchingPathMemory = createMemoryRule({
            uuid: 'non-matching-path-memory',
            repositoryId: 'repo-1',
            path: 'docs/**',
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const { service } = setup([
            pathlessMemory,
            matchingPathMemory,
            nonMatchingPathMemory,
        ]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
            path: 'src/components',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'matching-path-memory',
            'pathless-memory',
        ]);
    });

    it('filters memories by keywords and trims keyword input', async () => {
        const memoryA = createMemoryRule({
            uuid: 'memory-a',
            title: 'Use strict typing',
            rule: 'Prefer explicit return types',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });

        const memoryB = createMemoryRule({
            uuid: 'memory-b',
            title: 'Logging',
            rule: 'Log retry attempts',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const { service } = setup([memoryA, memoryB]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
            keywords: ['  strict  '],
        });

        expect(result.map((memory) => memory.uuid)).toEqual(['memory-a']);
    });

    it('clamps limit to min 1 and max 20', async () => {
        const memories = Array.from({ length: 25 }).map((_, index) =>
            createMemoryRule({
                uuid: `m-${index}`,
                repositoryId: 'repo-1',
                createdAt: new Date(
                    `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
                ),
            }),
        );

        const { service } = setup(memories);

        const limitedToOne = await service.findMemories(
            organizationAndTeamData,
            {
                repositoryId: 'repo-1',
                limit: 0,
            },
        );

        const limitedToTwenty = await service.findMemories(
            organizationAndTeamData,
            {
                repositoryId: 'repo-1',
                limit: 999,
            },
        );

        expect(limitedToOne).toHaveLength(1);
        expect(limitedToTwenty).toHaveLength(20);
    });

    it('returns most recent memories first', async () => {
        const oldMemory = createMemoryRule({
            uuid: 'old-memory',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        const newMemory = createMemoryRule({
            uuid: 'new-memory',
            repositoryId: 'repo-1',
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const { service } = setup([oldMemory, newMemory]);

        const result = await service.findMemories(organizationAndTeamData, {
            repositoryId: 'repo-1',
        });

        expect(result.map((memory) => memory.uuid)).toEqual([
            'new-memory',
            'old-memory',
        ]);
    });
});

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

/**
 * `createOrUpdate` keeps an explicit `origin` and otherwise defaults to
 * `MANUAL` — it does not infer from `sourcePath` (that's `resolveKodyRuleOrigin`).
 */
describe('KodyRulesService.createOrUpdate stamps origin', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildService = () => {
        const addRule = jest
            .fn()
            .mockImplementation((_docUuid, rule) =>
                Promise.resolve({ rules: [rule] }),
            );
        const repositoryMock = {
            // Existing doc with no rules → create lands on the addRule branch.
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ uuid: 'kr-1', rules: [] }),
            addRule,
        };

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any,
            {} as any,
            {} as any,
            { validateRulesLimit: jest.fn().mockResolvedValue(true) } as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        return { service, addRule };
    };

    const userInfo = { userId: 'u1', userEmail: 'u1@kodus.io' } as any;

    const baseRule = {
        title: 'New rule',
        rule: 'do something',
        path: '**/*',
        severity: 'medium',
        scope: KodyRulesScope.FILE,
        type: KodyRulesType.STANDARD,
    };

    const persistedSource = async (rulePayload: Record<string, unknown>) => {
        const { service, addRule } = buildService();
        await service.createOrUpdate(
            organizationAndTeamData,
            rulePayload as any,
            userInfo,
        );
        return addRule.mock.calls[0][1].origin;
    };

    it('keeps an explicit origin verbatim', async () => {
        expect(
            await persistedSource({
                ...baseRule,
                origin: KodyRulesOrigin.MCP_AGENT,
            }),
        ).toBe(KodyRulesOrigin.MCP_AGENT);
    });

    it('defaults to MANUAL when no origin is set (runtime does not infer from sourcePath — that is the migration helper job)', async () => {
        expect(
            await persistedSource({
                ...baseRule,
                sourcePath: '.cursorrules',
            }),
        ).toBe(KodyRulesOrigin.MANUAL);
    });

    it('defaults to MANUAL for a plain rule', async () => {
        expect(
            await persistedSource({
                ...baseRule,
                status: KodyRulesStatus.ACTIVE,
            }),
        ).toBe(KodyRulesOrigin.MANUAL);
    });
});

/**
 * Guards the core data-safety promise of every update/sync path: a partial
 * change must MERGE onto the stored rule, never replace it. `createOrUpdate`
 * (and the sync flows that call it) builds `{ ...existingRule, ...patch }`
 * before handing the rule to the repository, so any field the caller omits is
 * carried over from disk. These tests pin that merge at the service boundary —
 * i.e. they assert exactly what the service hands to `repository.updateRule` —
 * which, combined with the repository's field-level `$set` spec (per-field
 * write, undefined skipped), proves the full chain loses nothing.
 *
 * Why it matters: the previous repository write replaced the whole matched
 * array element (`rules.$`), so a partial patch — or a DTO carrying `undefined`
 * fields — silently wiped everything it didn't restate. Status toggles, IDE
 * syncs and reference updates all go through here.
 */
describe('KodyRulesService update/sync field preservation', () => {
    const organizationAndTeamData: OrganizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    // A fully-populated stored rule — every one of these fields must survive a
    // partial update that doesn't mention it.
    const existingRule: IKodyRule = {
        uuid: 'rule-1',
        type: KodyRulesType.STANDARD,
        title: 'Original title',
        rule: 'original body text',
        path: '**/*.ts',
        severity: 'high',
        status: KodyRulesStatus.ACTIVE,
        sourcePath: '.cursorrules',
        pinnedSync: true,
        repositoryId: 'repo-1',
        directoryId: 'dir-1',
        examples: [{ snippet: 'const x = 1;', isCorrect: true }] as any,
        origin: 'user' as any,
        scope: KodyRulesScope.FILE,
        contextReferenceId: 'ctx-ref-1',
        centralizedConfig: { path: '.kodus/rules.yml' } as any,
        inheritance: {
            inheritable: true,
            exclude: ['repo-x'],
            include: [],
        },
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
    } as IKodyRule;

    const buildService = () => {
        // Capture exactly what the service hands the repository for the update.
        const updateRule = jest
            .fn()
            .mockImplementation((_uuid, ruleId, updateData) =>
                Promise.resolve({ rules: [{ ...updateData, uuid: ruleId }] }),
            );

        const repositoryMock = {
            findByOrganizationId: jest.fn().mockResolvedValue({
                uuid: 'kr-doc-1',
                rules: [existingRule],
            }),
            updateRule,
            // validateRulesLimit lives on the validation service, but addRule
            // must exist in case a branch falls through.
            addRule: jest.fn().mockResolvedValue({ rules: [] }),
        };

        const validateRulesLimit = jest.fn().mockResolvedValue(true);

        const service = new KodyRulesService(
            repositoryMock as any,
            { emit: jest.fn() } as any, // eventEmitter
            {} as any, // ruleLikeService
            {} as any, // pullRequestsRepository
            { validateRulesLimit } as any, // kodyRulesValidationService
            {} as any, // mcpManagerService
            {} as any, // observabilityService
            {} as any, // permissionValidationService
            {} as any, // moduleRef
            {} as any, // codeBaseConfigService
            // kodyRuleSummaryService (optional) omitted → summary path skipped
        );

        return { service, updateRule };
    };

    const userInfo = { userId: 'u1', userEmail: 'u1@kodus.io' } as any;

    // Pull the `updateData` (3rd arg) the service handed to the repository.
    const capturedUpdate = (updateRule: jest.Mock) => updateRule.mock.calls[0][2];

    it('preserves every untouched field when only the status changes (pause)', async () => {
        const { service, updateRule } = buildService();

        await service.createOrUpdate(
            organizationAndTeamData,
            { uuid: 'rule-1', status: KodyRulesStatus.PAUSED } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);

        // The one intended change.
        expect(update.status).toBe(KodyRulesStatus.PAUSED);
        // Everything else carried over from disk — nothing wiped.
        expect(update.title).toBe('Original title');
        expect(update.rule).toBe('original body text');
        expect(update.path).toBe('**/*.ts');
        expect(update.severity).toBe('high');
        expect(update.sourcePath).toBe('.cursorrules');
        expect(update.pinnedSync).toBe(true);
        expect(update.examples).toEqual(existingRule.examples);
        expect(update.contextReferenceId).toBe('ctx-ref-1');
        expect(update.centralizedConfig).toEqual(existingRule.centralizedConfig);
        expect(update.inheritance).toEqual(existingRule.inheritance);
        expect(update.repositoryId).toBe('repo-1');
        expect(update.directoryId).toBe('dir-1');
        // updatedAt is always refreshed.
        expect(update.updatedAt).toBeInstanceOf(Date);
        expect(update.createdAt).toEqual(existingRule.createdAt);
    });

    it('normalizes severity to lower-case while preserving the rest', async () => {
        const { service, updateRule } = buildService();

        await service.createOrUpdate(
            organizationAndTeamData,
            { uuid: 'rule-1', severity: 'Critical' } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.severity).toBe('critical');
        // Title/body untouched.
        expect(update.title).toBe('Original title');
        expect(update.status).toBe(KodyRulesStatus.ACTIVE);
    });

    it('keeps the stored severity when the patch omits it (no undefined clobber)', async () => {
        const { service, updateRule } = buildService();

        // A patch that changes the body but says nothing about severity. The
        // `mergedSeverity ?? existingRule.severity` guard must re-apply 'high'.
        await service.createOrUpdate(
            organizationAndTeamData,
            { uuid: 'rule-1', rule: 'updated body' } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.rule).toBe('updated body');
        expect(update.severity).toBe('high');
    });

    it('sync de-pin path: flipping pinnedSync keeps title/severity/inheritance', async () => {
        const { service, updateRule } = buildService();

        // Mirrors kodyRulesSync.service.ts de-pin: `{ ...rule, pinnedSync: false }`.
        await service.createOrUpdate(
            organizationAndTeamData,
            { ...existingRule, pinnedSync: false } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.pinnedSync).toBe(false);
        expect(update.title).toBe('Original title');
        expect(update.severity).toBe('high');
        expect(update.inheritance).toEqual(existingRule.inheritance);
        expect(update.status).toBe(KodyRulesStatus.ACTIVE);
    });

    it('sync soft-delete path: flipping status to DELETED keeps the rule body', async () => {
        const { service, updateRule } = buildService();

        // Mirrors kodyRulesSync.service.ts soft-delete: `{ ...rule, status: DELETED }`.
        await service.createOrUpdate(
            organizationAndTeamData,
            { ...existingRule, status: KodyRulesStatus.DELETED } as any,
            userInfo,
        );

        const update = capturedUpdate(updateRule);
        expect(update.status).toBe(KodyRulesStatus.DELETED);
        // Soft delete must be reversible — body + source must remain intact.
        expect(update.title).toBe('Original title');
        expect(update.rule).toBe('original body text');
        expect(update.sourcePath).toBe('.cursorrules');
        expect(update.contextReferenceId).toBe('ctx-ref-1');
    });

    it('updateRuleReferences sets the contextReferenceId and preserves the rule', async () => {
        const { service, updateRule } = buildService();

        await service.updateRuleReferences('org-1', 'rule-1', {
            contextReferenceId: 'ctx-ref-2',
        });

        const update = capturedUpdate(updateRule);
        expect(update.contextReferenceId).toBe('ctx-ref-2');
        expect(update.title).toBe('Original title');
        expect(update.rule).toBe('original body text');
        expect(update.severity).toBe('high');
        expect(update.inheritance).toEqual(existingRule.inheritance);
    });
});
