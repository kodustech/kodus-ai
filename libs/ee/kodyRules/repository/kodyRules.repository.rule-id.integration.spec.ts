/**
 * The rule-id writes match the id literally. A rule id that arrives as an
 * object (`{ $ne: null }`) would otherwise become a query operator: the
 * `$pull` would remove every rule of the organization, and the positional
 * update would patch whichever rule matched first.
 *
 * Runs against a REAL MongoDB in a throwaway database.
 */
import mongoose, { Connection, Model } from 'mongoose';

import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    KodyRulesModel,
    KodyRulesSchema,
} from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';

import { KodyRulesRepository } from './kodyRules.repository';
import { resolveMongoTestGate } from '../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it, fails in CI
// when the URI is missing instead of passing with nothing asserted.
// No API_MG_DB_HOST fallback: that is a docker-network hostname that never
// resolves from the host, so a local .env carrying it must skip, not fail.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'kodus_kody_rules_rule_id_it';
const ORG = 'org-rule-id-it';
const injected = { $ne: null } as unknown as string;

const rule = (uuid: string) => ({
    uuid,
    title: `Rule ${uuid}`,
    rule: 'Text.',
    status: KodyRulesStatus.ACTIVE,
});

(gate.shouldSkip ? describe.skip : describe)(
    'Kody Rules writes keyed by a rule id (real MongoDB)',
    () => {
        let connection: Connection;
        let model: Model<KodyRulesModel>;
        let repository: KodyRulesRepository;
        let docId: string;

        const storedRules = async () =>
            ((await model.findById(docId).lean().exec()) as any).rules.map(
                (r: any) => ({ uuid: r.uuid, title: r.title }),
            );

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            await connection.dropDatabase();
            model = connection.model<KodyRulesModel>(
                KodyRulesModel.name,
                KodyRulesSchema,
            );
            repository = new KodyRulesRepository(model as any, {} as any);
        }, 30_000);

        beforeEach(async () => {
            await model.deleteMany({});
            const created = await model.create({
                organizationId: ORG,
                rules: [rule('r1'), rule('r2')],
            } as any);
            docId = String(created._id);
        });

        afterAll(async () => {
            await connection?.dropDatabase();
            await connection?.close();
        });

        it('deleteRule with an object id removes no rule', async () => {
            await repository.deleteRule(docId, injected);

            expect(await storedRules()).toEqual([
                { uuid: 'r1', title: 'Rule r1' },
                { uuid: 'r2', title: 'Rule r2' },
            ]);
        });

        // A guard, not a pin: $eq must leave the ordinary delete working.
        it('deleteRule with a real id removes that rule only', async () => {
            expect(await repository.deleteRule(docId, 'r1')).toBe(true);

            expect(await storedRules()).toEqual([
                { uuid: 'r2', title: 'Rule r2' },
            ]);
        });

        it('updateRuleFieldsByOrganization with an object id patches no rule', async () => {
            const result = await repository.updateRuleFieldsByOrganization(
                ORG,
                injected,
                { title: 'Hijacked' } as any,
            );

            expect(result).toBeNull();
            expect(await storedRules()).toEqual([
                { uuid: 'r1', title: 'Rule r1' },
                { uuid: 'r2', title: 'Rule r2' },
            ]);
        });

        it('deleteRuleLogically with an object id marks no rule deleted', async () => {
            expect(await repository.deleteRuleLogically(ORG, injected)).toBe(
                false,
            );

            const stored: any = await model.findById(docId).lean().exec();
            expect(stored.rules.map((r: any) => r.status)).toEqual([
                KodyRulesStatus.ACTIVE,
                KodyRulesStatus.ACTIVE,
            ]);
        });
    },
);
