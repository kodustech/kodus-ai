/**
 * The ledger's state writes against a real MongoDB, in a throwaway database:
 * a charge moves only while pending and only within its organization.
 */
import mongoose, { Connection, Model } from 'mongoose';

import { KodusCreditsLedgerRepository } from './kodus-credits-ledger.repository';
import {
    KodusCreditChargeModel,
    KodusCreditChargeModelSchema,
} from './schemas/kodusCreditCharge.model';
import { resolveMongoTestGate } from '../../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'kodus_credits_ledger_it';

(gate.shouldSkip ? describe.skip : describe)(
    'KodusCreditsLedgerRepository state writes (real MongoDB)',
    () => {
        let connection: Connection;
        let model: Model<KodusCreditChargeModel>;
        let ledger: KodusCreditsLedgerRepository;
        const settledAt = new Date('2026-11-01T00:00:00Z');
        const charge = (
            spanId: string,
            organizationId: string,
            status: string,
            extra: Record<string, unknown> = {},
        ) => ({
            spanId,
            organizationId,
            status,
            modelId: 'kodus:model',
            tokens: {
                input: 1,
                output: 1,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
            },
            amountUsd: 0.01,
            spanAt: new Date('2026-11-20T00:00:00Z'),
            ...extra,
        });
        const stored = async (spanId: string) =>
            (await model.findOne({ spanId }).lean().exec()) as any;

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            await connection.dropDatabase();
            model = connection.model<KodusCreditChargeModel>(
                KodusCreditChargeModel.name,
                KodusCreditChargeModelSchema,
            );
            ledger = new KodusCreditsLedgerRepository(
                {} as any,
                model as any,
                {} as any,
            );
        }, 30_000);

        beforeEach(async () => {
            await model.deleteMany({});
            await model.collection.insertMany([
                charge('pending-1', 'org-1', 'pending'),
                charge('settled-1', 'org-1', 'debited', {
                    debitedAt: settledAt,
                }),
                charge('other-org', 'org-2', 'pending'),
                // Pending and in org-1, but never passed: proves the writes
                // follow the span ids and not just organization + status.
                charge('unlisted-1', 'org-1', 'pending'),
            ] as any[]);
        });

        afterAll(async () => {
            await connection?.dropDatabase();
            await connection?.close();
        });

        it("debits only the organization's pending charges", async () => {
            const at = new Date('2026-11-20T12:00:00Z');

            await ledger.markChargesDebited(
                'org-1',
                ['pending-1', 'settled-1', 'other-org'],
                at,
            );

            expect(await stored('pending-1')).toMatchObject({
                status: 'debited',
                debitedAt: at,
            });
            // Settled by another pass: keeps its own debitedAt.
            expect((await stored('settled-1')).debitedAt).toEqual(settledAt);
            // Another organization's charge is untouched.
            expect(await stored('other-org')).toMatchObject({
                status: 'pending',
            });
            expect((await stored('other-org')).debitedAt).toBeUndefined();
            // A pending charge of the same organization that was not listed.
            expect(await stored('unlisted-1')).toMatchObject({
                status: 'pending',
            });
            expect((await stored('unlisted-1')).debitedAt).toBeUndefined();
        });

        it("records a debit error only on the organization's pending charges", async () => {
            await ledger.recordChargeError(
                'org-1',
                ['pending-1', 'settled-1', 'other-org'],
                'billing down',
            );

            expect((await stored('pending-1')).lastError).toBe('billing down');
            expect((await stored('settled-1')).lastError).toBeUndefined();
            expect((await stored('other-org')).lastError).toBeUndefined();
            expect((await stored('unlisted-1')).lastError).toBeUndefined();
        });
    },
);
