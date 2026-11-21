/**
 * The release's index migration and the app's connection options against a
 * real MongoDB, in throwaway databases dropped after the run.
 */
import mongoose, { Connection } from 'mongoose';

import { MongooseFactory } from '../../mongodb/mongoose.factory';
import { resolveMongoTestGate } from '../../../../../../test/integration/mongo-test-uri';

import {
    ensureReleaseIndexes,
    RELEASE_INDEXES,
} from './ensure-release-indexes';

// Runs in CI (TEST_MONGODB_URI); skips locally without it.
const gate = resolveMongoTestGate('kodus_test', false);
const TEST_DB = 'kodus_release_indexes_it';

const withQuery = (uri: string, query: string) =>
    `${uri}${uri.includes('?') ? '&' : '?'}${query}`;

(gate.shouldSkip ? describe.skip : describe)(
    'release indexes and connection options (real MongoDB)',
    () => {
        // Through Mongoose, as the other Mongo integration specs: under Jest a
        // bare `mongodb` import can resolve to another copy of the driver.
        let connection: Connection;
        const db = () => connection.db as any;

        beforeAll(async () => {
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
        }, 30_000);

        beforeEach(async () => {
            await connection.dropDatabase();
        });

        afterAll(async () => {
            await connection?.dropDatabase();
            await connection?.close();
        });

        const stored = async (collection: string, name: string) =>
            (await db().collection(collection).indexes()).find(
                (index) => index.name === name,
            );

        it('builds every index of the release with its rules, and a second run changes nothing', async () => {
            const first = await ensureReleaseIndexes(db(), () => undefined);
            const second = await ensureReleaseIndexes(db(), () => undefined);

            expect(first.failed).toEqual([]);
            expect(second.failed).toEqual([]);
            for (const { collection, key, options } of RELEASE_INDEXES) {
                const index = await stored(collection, options.name);
                expect(index?.key).toEqual(key);
                expect(index?.unique).toBe(options.unique);
                expect(index?.partialFilterExpression).toEqual(
                    options.partialFilterExpression,
                );
                expect(index?.expireAfterSeconds).toBe(
                    options.expireAfterSeconds,
                );
            }
        });

        it('reports a unique index the data refuses and still builds the others', async () => {
            // Two scans already active on one repository.
            await db()
                .collection('security_scans')
                .insertMany([
                    { activeKey: 'org:repo' },
                    { activeKey: 'org:repo' },
                ]);
            const log: string[] = [];

            const result = await ensureReleaseIndexes(db(), (m) => log.push(m));

            expect(result.failed.map((f) => f.index)).toEqual([
                'security_scans.one_active_scan_per_repository',
            ]);
            expect(result.ensured).toHaveLength(RELEASE_INDEXES.length - 1);
            expect(log.some((m) => m.includes('ERROR'))).toBe(true);
            // The duplicate's values stay out of the boot log.
            expect(log.join('\n')).not.toContain('org:repo');
            expect(JSON.stringify(result.failed)).not.toContain('org:repo');
            expect(
                await stored(
                    'security_scans',
                    'one_active_scan_per_repository',
                ),
            ).toBeUndefined();
        });

        it('the app connects with a URI that reads from secondaries', async () => {
            const { uri, connectionFactory, dbName, ...options } =
                new MongooseFactory({
                    get: (key: string, fallback?: unknown) =>
                        key === 'mongoDatabase'
                            ? { url: gate.mongoUri, database: TEST_DB }
                            : fallback,
                } as any).createMongooseOptions() as Record<string, any>;
            void uri;
            void connectionFactory;

            const secondaryRead = await mongoose
                .createConnection(
                    withQuery(
                        gate.mongoUri,
                        'readPreference=secondaryPreferred',
                    ),
                    { ...options, dbName, serverSelectionTimeoutMS: 5000 },
                )
                .asPromise();
            try {
                expect(secondaryRead.readyState).toBe(1);
                // It reads from secondaries, and Mongoose turned index builds
                // off for it rather than refusing the connection.
                expect(secondaryRead.getClient().readPreference.mode).toBe(
                    'secondaryPreferred',
                );
                expect((secondaryRead as any).config?.autoIndex).toBe(false);
            } finally {
                await secondaryRead.close();
            }
        });
    },
);
