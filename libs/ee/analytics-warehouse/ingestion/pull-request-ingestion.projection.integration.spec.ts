/**
 * The warehouse ingestion reads each changed PR without its patches: they are
 * most of what a PR document weighs (up to 8 MB) and no warehouse query reads
 * a diff. Everything the warehouse writes from the files must still arrive.
 *
 * Runs against a REAL MongoDB (the projection semantics are the server's):
 * TEST_MONGODB_URI in CI, which fails when it is missing; skipped locally
 * without it.
 */
import mongoose, { Connection } from 'mongoose';

import { resolveMongoTestGate } from '../../../../test/integration/mongo-test-uri';

import { PULL_REQUEST_INGESTION_PROJECTION } from './pull-request-ingestion.service';

// No API_MG_DB_HOST fallback: that is a docker-network hostname that never
// resolves from the host, so a local .env carrying it must skip, not fail.
const gate = resolveMongoTestGate('kodus_test', false);

const TEST_DB = 'kodus_ingestion_projection_it';

(gate.shouldSkip ? describe.skip : describe)(
    'pull request ingestion projection (real MongoDB)',
    () => {
        let connection: Connection | null = null;
        let client: any = null;

        beforeAll(async () => {
            // Connected through Mongoose: the bare mongodb 7.6 driver builds its
            // handshake metadata from a Map that serializes empty inside Jest's realm,
            // and the server rejects the connection.
            connection = await mongoose
                .createConnection(gate.mongoUri, {
                    serverSelectionTimeoutMS: 5000,
                })
                .asPromise();
            client = connection.getClient();
        });

        afterAll(async () => {
            await client?.db(TEST_DB).dropDatabase();
            await connection?.close();
        });

        it('brings every file field the warehouse writes, and no patch', async () => {
            const prs = client!.db(TEST_DB).collection('pullRequests');
            await prs.insertOne({
                organizationId: 'org',
                number: 3,
                status: 'open',
                updatedAt: new Date(),
                files: [
                    {
                        id: 'f1',
                        path: 'src/a.ts',
                        filename: 'a.ts',
                        status: 'modified',
                        added: 3,
                        deleted: 1,
                        changes: 4,
                        patch: '@@ -1 +1 @@\n-x\n+y\n'.repeat(1000),
                        patchTruncated: false,
                        suggestions: [
                            { id: 's1', deliveryStatus: 'sent', label: 'bug' },
                        ],
                    },
                ],
                commits: [{ sha: 'c1' }],
            });

            const doc: any = await prs.findOne(
                { number: 3 },
                { projection: PULL_REQUEST_INGESTION_PROJECTION },
            );

            expect(doc.files[0]).not.toHaveProperty('patch');
            expect(doc.files[0]).toMatchObject({
                id: 'f1',
                path: 'src/a.ts',
                filename: 'a.ts',
                status: 'modified',
                added: 3,
                deleted: 1,
                changes: 4,
                patchTruncated: false,
                suggestions: [
                    { id: 's1', deliveryStatus: 'sent', label: 'bug' },
                ],
            });
            expect(doc.commits).toEqual([{ sha: 'c1' }]);
            expect(doc.number).toBe(3);
        });
    },
);
