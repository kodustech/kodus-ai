import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import {
    IKodyRule,
    IKodyRuleContextNeed,
    IKodyRuleFileScope,
    KodyRulesScope,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

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
