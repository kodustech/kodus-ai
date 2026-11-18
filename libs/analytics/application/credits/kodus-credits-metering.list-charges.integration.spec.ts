/**
 * Listing one PR's credit charges reads that PR's charges, not the
 * organization's whole history until enough of them turn up.
 *
 * Runs the real listCharges against a REAL MongoDB (the schema's indexes,
 * built as on boot); skipped when none is reachable. Point it at one with
 * CREDITS_IT_MONGO_URI (or MONGODB_URI).
 */
import mongoose, { Connection } from 'mongoose';

import {
    KodusCreditChargeModel,
    KodusCreditChargeModelSchema,
} from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';
import { buildMongoUri } from '@libs/core/infrastructure/database/mongo/mongo-migration-client';

import { KodusCreditsMeteringService } from './kodus-credits-metering.service';

const TEST_DB = 'kodus_credits_list_it';
const ORG = 'org-credits-it';

let connection: Connection | null = null;
let available = false;

describe('listCharges for one PR (real MongoDB)', () => {
    let service: KodusCreditsMeteringService;
    let model: mongoose.Model<KodusCreditChargeModel>;
    const finds: any[] = [];

    beforeAll(async () => {
        try {
            connection = await mongoose
                .createConnection(
                    process.env.CREDITS_IT_MONGO_URI ??
                        process.env.MONGODB_URI ??
                        buildMongoUri(),
                    {
                        dbName: TEST_DB,
                        monitorCommands: true,
                        serverSelectionTimeoutMS: 2000,
                    },
                )
                .asPromise();
            available = true;
        } catch {
            console.warn('[credits-list-it] no Mongo reachable — skipping');
            return;
        }
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
            {} as any,
            model as any,
            {} as any,
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
        if (!available) return;

        const charges = await service.listCharges(ORG, {
            prNumber: 7,
            limit: 5,
        });

        expect(charges).toHaveLength(5);
        expect(charges.every((c: any) => c.prNumber === 7)).toBe(true);

        const command = finds.at(-1);
        const explained: any = await model.collection
            .find(command.filter, { sort: command.sort, limit: command.limit })
            .explain('executionStats');
        expect(explained.executionStats.totalKeysExamined).toBeLessThanOrEqual(
            6,
        );
        expect(JSON.stringify(explained.queryPlanner.winningPlan)).toContain(
            'idx_org_pr_spanAt',
        );
    });
});
