/**
 * The warehouse ingestion reads each changed PR without its patches: they are
 * most of what a PR document weighs (up to 8 MB) and no warehouse query reads
 * a diff. Everything the warehouse writes from the files must still arrive.
 *
 * Runs against a REAL MongoDB (the projection semantics are the server's);
 * skipped when none is reachable. Point it at one with
 * INGESTION_IT_MONGO_URI (or MONGODB_URI).
 */
import { MongoClient } from 'mongodb';

import { buildMongoUri } from '@libs/core/infrastructure/database/mongo/mongo-migration-client';

import { PULL_REQUEST_INGESTION_PROJECTION } from './pull-request-ingestion.service';

const TEST_DB = 'kodus_ingestion_projection_it';

describe('pull request ingestion projection (real MongoDB)', () => {
    let client: MongoClient | null = null;
    let available = false;

    beforeAll(async () => {
        try {
            client = new MongoClient(
                process.env.INGESTION_IT_MONGO_URI ??
                    process.env.MONGODB_URI ??
                    buildMongoUri(),
                { serverSelectionTimeoutMS: 2000 },
            );
            await client.connect();
            available = true;
        } catch {
            console.warn(
                '[ingestion-projection-it] no Mongo reachable — skipping',
            );
        }
    });

    afterAll(async () => {
        if (available) await client!.db(TEST_DB).dropDatabase();
        await client?.close();
    });

    it('brings every file field the warehouse writes, and no patch', async () => {
        if (!available) return;
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
            suggestions: [{ id: 's1', deliveryStatus: 'sent', label: 'bug' }],
        });
        expect(doc.commits).toEqual([{ sha: 'c1' }]);
        expect(doc.number).toBe(3);
    });
});
