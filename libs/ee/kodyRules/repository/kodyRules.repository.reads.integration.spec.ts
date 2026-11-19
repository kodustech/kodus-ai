/**
 * The review reads an organization's rules without the deleted ones, which
 * stay in the document and can be most of it; a plan sync writes all its
 * per-rule changes in one round trip, each touching only its rule's fields.
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
const TEST_DB = 'kodus_kody_rules_reads_it';
const ORG = 'org-rules-it';

const rule = (uuid: string, status: KodyRulesStatus, over = {}) => ({
    uuid,
    title: uuid,
    rule: `text of ${uuid} `.repeat(50),
    status,
    lockedByPlan: false,
    repositoryId: 'repo',
    ...over,
});

let connection: Connection | null = null;
let available = false;

(gate.shouldSkip ? describe.skip : describe)(
    'Kody Rules reads and plan writes (real MongoDB)',
    () => {
        let model: Model<KodyRulesModel>;
        let repository: KodyRulesRepository;
        let docId: string;
        const commands: string[] = [];

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: TEST_DB,
                    monitorCommands: true,
                    serverSelectionTimeoutMS: 2000,
                })
                .asPromise();
            available = true;
            await connection.dropDatabase();
            connection.getClient().on('commandStarted', (event) => {
                if (event.command[event.commandName] === 'kodyRules') {
                    commands.push(event.commandName);
                }
            });
            model = connection.model<KodyRulesModel>(
                KodyRulesModel.name,
                KodyRulesSchema,
            );
            // The schema's index build runs in the background on compile; a
            // late createIndexes would land among the commands a test counts.
            await model.init();
            const created = await model.create({
                organizationId: ORG,
                rules: [
                    rule('live-1', KodyRulesStatus.ACTIVE),
                    rule('live-2', KodyRulesStatus.PAUSED, {
                        lockedByPlan: true,
                    }),
                    ...Array.from({ length: 50 }, (_, i) =>
                        rule(`gone-${i}`, KodyRulesStatus.DELETED),
                    ),
                ],
            });
            docId = String(created._id);
            repository = new KodyRulesRepository(model as any, {} as any);
        }, 30_000);

        afterAll(async () => {
            if (connection) {
                if (available) await connection.dropDatabase();
                await connection.close();
            }
        });

        it('reads the live rules without the deleted ones', async () => {
            const live = await repository.findLiveRulesByOrganizationId(ORG);
            const all = await repository.findByOrganizationId(ORG);

            expect(live?.rules.map((r) => r.uuid)).toEqual([
                'live-1',
                'live-2',
            ]);
            expect(live?.uuid).toBe(docId);
            expect(all?.rules).toHaveLength(52);
        });

        it("writes each rule's changes in one round trip and only its fields", async () => {
            commands.length = 0;

            const failed = await repository.updateRulesFields(docId, [
                {
                    ruleId: 'live-1',
                    patch: {
                        status: KodyRulesStatus.PAUSED,
                        lockedByPlan: true,
                    },
                },
                {
                    ruleId: 'live-2',
                    patch: {
                        status: KodyRulesStatus.ACTIVE,
                        lockedByPlan: false,
                    },
                },
                // A rule that is not in the document matches nothing.
                { ruleId: 'missing', patch: { lockedByPlan: true } },
            ]);

            expect(failed).toEqual([]);
            expect(commands).toEqual(['update']);
            const doc: any = await model.findById(docId).lean();
            const byId = Object.fromEntries(
                doc.rules.map((r: any) => [r.uuid, r]),
            );
            expect(byId['live-1']).toMatchObject({
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
                title: 'live-1',
            });
            expect(byId['live-2']).toMatchObject({
                status: KodyRulesStatus.ACTIVE,
                lockedByPlan: false,
            });
            expect(byId['live-1'].rule).toContain('text of live-1');
            expect(doc.rules).toHaveLength(52);
        });
    },
);
