/**
 * INTEGRATION — KodyRulesRepository.updateRuleFieldsByOrganization against a
 * real MongoDB.
 *
 * The single-rule update used by Kody Rules sync (updateRuleReferences /
 * updateRuleDetector) used to read the organization's whole document and
 * write one rule back. It now issues one positional `$set` and projects the
 * one rule. The unit tests pin the service contract; what only shows up
 * against Mongo is:
 *   1. the `$elemMatch` projection returns exactly the touched rule;
 *   2. the positional `$set` changes only that rule's named fields;
 *   3. the stored result equals what the old read-then-write produced.
 *
 * Synthetic data only. Skipped on a dev machine without `TEST_MONGODB_URI`;
 * a hard failure in CI (see test/integration/mongo-test-uri.ts).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { KodyRulesRepository } from '@libs/ee/kodyRules/repository/kodyRules.repository';
import {
    IKodyRule,
    KodyRulesScope,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    KodyRulesModel,
    KodyRulesSchema,
} from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { resolveMongoTestGate } from '../mongo-test-uri';

const { shouldSkip, mongoUri } = resolveMongoTestGate('kodus_test_kodyrules');

const RULE_COUNT = 600;

function syntheticRules(prefix: string): IKodyRule[] {
    return Array.from({ length: RULE_COUNT }, (_, i) => ({
        uuid: `${prefix}-rule-${i}`,
        title: `Rule ${i}`,
        rule: `Do not do thing number ${i}. `.repeat(20),
        path: '**/*.ts',
        severity: 'medium',
        status: KodyRulesStatus.ACTIVE,
        // Every third rule has no stored scope (legacy shape).
        ...(i % 3 === 0 ? {} : { scope: KodyRulesScope.FILE }),
        contextReferenceId: `ctx-old-${i}`,
        detector: i % 2 === 0 ? { pattern: `p${i}` } : undefined,
        examples: [{ snippet: `example ${i}`, isCorrect: true }],
        // Synthetic fixture: only the fields these tests read are filled in.
    })) as unknown as IKodyRule[];
}

(shouldSkip ? describe.skip : describe)(
    'KodyRulesRepository.updateRuleFieldsByOrganization (real Mongo)',
    () => {
        let module: TestingModule;
        let repository: KodyRulesRepository;
        let model: Model<KodyRulesModel>;

        const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ORG = `test-org-kr-${RUN}`;
        const ORG_OLD = `test-org-kr-old-${RUN}`;

        beforeAll(async () => {
            module = await Test.createTestingModule({
                imports: [
                    MongooseModule.forRoot(mongoUri),
                    MongooseModule.forFeature([
                        { name: KodyRulesModel.name, schema: KodyRulesSchema },
                    ]),
                ],
                providers: [
                    {
                        provide: KodyRulesRepository,
                        useFactory: (m: Model<KodyRulesModel>) =>
                            new KodyRulesRepository(m, {} as any),
                        inject: [getModelToken(KodyRulesModel.name)],
                    },
                ],
            }).compile();

            repository = module.get(KodyRulesRepository);
            model = module.get(getModelToken(KodyRulesModel.name));
        });

        beforeEach(async () => {
            await model.deleteMany({
                organizationId: { $in: [ORG, ORG_OLD] },
            });
            await model.create({
                organizationId: ORG,
                rules: syntheticRules('a'),
            });
            await model.create({
                organizationId: ORG_OLD,
                rules: syntheticRules('a'),
            });
        });

        afterAll(async () => {
            await model.deleteMany({
                organizationId: { $in: [ORG, ORG_OLD] },
            });
            await module.close();
        });

        const storedRules = async (organizationId: string) =>
            ((await model.findOne({ organizationId }).lean().exec()) as any)
                .rules as any[];

        it('returns only the touched rule, with the new values', async () => {
            const result = await repository.updateRuleFieldsByOrganization(
                ORG,
                'a-rule-300',
                { contextReferenceId: 'ctx-new' },
            );

            expect(result).not.toBeNull();
            expect(result!.uuid).toBe('a-rule-300');
            expect(result!.contextReferenceId).toBe('ctx-new');
            expect(result!.title).toBe('Rule 300');
        });

        it('normalizes a missing scope to FILE in the return, like entity.rules', async () => {
            // a-rule-3 has no stored scope (i % 3 === 0).
            const result = await repository.updateRuleFieldsByOrganization(
                ORG,
                'a-rule-3',
                { contextReferenceId: 'ctx-new' },
            );
            expect(result!.scope).toBe(KodyRulesScope.FILE);
        });

        it('changes only the named fields of the one rule', async () => {
            const before = await storedRules(ORG);

            await repository.updateRuleFieldsByOrganization(ORG, 'a-rule-42', {
                contextReferenceId: 'ctx-new',
            });

            const after = await storedRules(ORG);
            expect(after).toHaveLength(RULE_COUNT);
            after.forEach((rule, i) => {
                if (rule.uuid === 'a-rule-42') {
                    expect({
                        ...rule,
                        contextReferenceId: before[i].contextReferenceId,
                    }).toEqual(before[i]);
                    expect(rule.contextReferenceId).toBe('ctx-new');
                } else {
                    expect(rule).toEqual(before[i]);
                }
            });
        });

        it('writes null and skips undefined', async () => {
            await repository.updateRuleFieldsByOrganization(ORG, 'a-rule-10', {
                detector: null as any,
                contextReferenceId: undefined,
            });

            const rule = (await storedRules(ORG)).find(
                (r) => r.uuid === 'a-rule-10',
            );
            expect(rule.detector).toBeNull();
            expect(rule.contextReferenceId).toBe('ctx-old-10');
        });

        it('returns null for an unknown rule or another organization, and writes nothing', async () => {
            const before = await storedRules(ORG);

            await expect(
                repository.updateRuleFieldsByOrganization(ORG, 'nope', {
                    contextReferenceId: 'x',
                }),
            ).resolves.toBeNull();
            await expect(
                repository.updateRuleFieldsByOrganization(
                    'other-org',
                    'a-rule-1',
                    { contextReferenceId: 'x' },
                ),
            ).resolves.toBeNull();

            expect(await storedRules(ORG)).toEqual(before);
        });

        it('reads instead of writing when every field is undefined', async () => {
            const before = await storedRules(ORG);
            const result = await repository.updateRuleFieldsByOrganization(
                ORG,
                'a-rule-7',
                { contextReferenceId: undefined },
            );
            expect(result!.uuid).toBe('a-rule-7');
            expect(await storedRules(ORG)).toEqual(before);
        });

        it('stores the same rules as the old read-then-write (scope stamp aside)', async () => {
            const targets = [
                'a-rule-0',
                'a-rule-1',
                'a-rule-299',
                'a-rule-599',
            ];
            const updatedAt = new Date('2026-11-10T12:00:00.000Z');

            for (const ruleId of targets) {
                // Old path: whole document, entity-normalized rule, every
                // field written back with the change on top.
                const existing = await repository.findByOrganizationId(ORG_OLD);
                const existingRule = existing!.rules.find(
                    (r) => r.uuid === ruleId,
                );
                await repository.updateRule(existing!.uuid, ruleId, {
                    ...existingRule,
                    contextReferenceId: `ctx-${ruleId}`,
                    updatedAt,
                } as any);

                // New path.
                await repository.updateRuleFieldsByOrganization(ORG, ruleId, {
                    contextReferenceId: `ctx-${ruleId}`,
                    updatedAt,
                } as any);
            }

            const oldRules = await storedRules(ORG_OLD);
            const newRules = await storedRules(ORG);
            expect(newRules).toHaveLength(oldRules.length);

            // The only intended difference: the old path also persisted the
            // read-time `scope: FILE` default on rules that had none stored.
            const withoutStampedScope = (rule: any, original: any) => {
                const copy = { ...rule };
                if (original.scope === undefined) delete copy.scope;
                return copy;
            };
            const originals = syntheticRules('a');
            oldRules.forEach((rule, i) => {
                expect(withoutStampedScope(newRules[i], originals[i])).toEqual(
                    withoutStampedScope(rule, originals[i]),
                );
            });
        });

        it('existsForOrganization reflects whether the organization has a document', async () => {
            await expect(repository.existsForOrganization(ORG)).resolves.toBe(
                true,
            );
            await expect(
                repository.existsForOrganization(`missing-${RUN}`),
            ).resolves.toBe(false);
        });
    },
);
