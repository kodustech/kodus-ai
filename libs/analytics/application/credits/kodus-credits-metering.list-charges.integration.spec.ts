/**
 * Listing one PR's credit charges reads that PR's charges, not the
 * organization's whole history until enough of them turn up.
 *
 * Runs the real listCharges against a REAL MongoDB (the schema's indexes,
 * built as on boot).
 */
import { KodusCreditsLedgerRepository } from '@libs/analytics/infrastructure/adapters/repositories/kodus-credits-ledger.repository';
import mongoose, { Connection } from 'mongoose';

import {
    KodusCreditChargeModel,
    KodusCreditChargeModelSchema,
} from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';

import { KodusCreditsMeteringService } from './kodus-credits-metering.service';
import { resolveMongoTestGate } from '../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it, fails in CI
// when the URI is missing instead of passing with nothing asserted.
// No API_MG_DB_HOST fallback: that is a docker-network hostname that never
// resolves from the host, so a local .env carrying it must skip, not fail.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'kodus_credits_list_it';
const ORG = 'org-credits-it';

let connection: Connection | null = null;
let available = false;

(gate.shouldSkip ? describe.skip : describe)(
    'listCharges for one PR (real MongoDB)',
    () => {
        let service: KodusCreditsMeteringService;
        let model: mongoose.Model<KodusCreditChargeModel>;
        const finds: any[] = [];

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
                if (event.commandName === 'find') finds.push(event.command);
            });
            model = connection.model(
                KodusCreditChargeModel.name,
                KodusCreditChargeModelSchema,
            );
            await model.init();
            const base = Date.parse('2026-11-01T00:00:00Z');
            await model.collection.insertMany(
                Array.from({ length: 2000 }, (_, i) => ({
                    spanId: `span-${i}`,
                    organizationId: ORG,
                    // The PR asked for has the oldest charges, so walking the
                    // organization's history newest-first reaches them last.
                    prNumber: i < 5 ? 7 : 100 + (i % 50),
                    modelId: 'm',
                    amountUsd: 0.01,
                    status: 'debited',
                    spanAt: new Date(base + i * 60_000),
                })),
            );
            service = new KodusCreditsMeteringService(
                new KodusCreditsLedgerRepository(
                    {} as any,
                    model as any,
                    {} as any,
                ),
                {} as any,
                {} as any,
            );
        }, 30_000);

        afterAll(async () => {
            if (connection) {
                if (available) await connection.dropDatabase();
                await connection.close();
            }
        });

        it("reads the PR's charges straight from its index entries", async () => {
            const charges = await service.listCharges(ORG, {
                prNumber: 7,
                limit: 5,
            });

            expect(charges).toHaveLength(5);
            expect(charges.every((c: any) => c.prNumber === 7)).toBe(true);

            const command = finds.at(-1);
            const explained: any = await model.collection
                .find(command.filter, {
                    sort: command.sort,
                    limit: command.limit,
                })
                .explain('executionStats');
            expect(
                explained.executionStats.totalKeysExamined,
            ).toBeLessThanOrEqual(6);
            expect(
                JSON.stringify(explained.queryPlanner.winningPlan),
            ).toContain('idx_org_pr_spanAt');
        });
    },
);
