/**
 * @file purge-legacy-agent-sessions.ts
 *
 * One-shot cleanup for `kodus-agent-sessions`.
 *
 * The collection now expires a conversation 30 days after its last reply,
 * through the `ttl_updatedAt` index (agent-session.model.ts). Documents the
 * legacy flow engine wrote have no `updatedAt`, so that index never reaches
 * them. This removes those whose last activity is older than the same 30 days.
 * A legacy document that received a reply since then carries `updatedAt` and
 * is left to the TTL.
 *
 * Dry run by default: prints what it would delete and deletes nothing.
 *
 * Usage:
 *   npx tsx scripts/purge-legacy-agent-sessions.ts [--apply] [--env .env.prod]
 *
 *   --apply     Delete, in batches of 5,000, pausing between batches.
 *   --env FILE  Load a specific env file (default: .env).
 */

import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

import {
    buildMongoUri,
    mongoDatabaseName,
} from '../libs/core/infrastructure/database/mongo/mongo-migration-client';

const envFlagIndex = process.argv.indexOf('--env');
loadEnv({
    path: resolve(
        process.cwd(),
        envFlagIndex !== -1 ? process.argv[envFlagIndex + 1] : '.env',
    ),
});

const APPLY = process.argv.includes('--apply');
const COLLECTION = 'kodus-agent-sessions';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH = 5000;
const PAUSE_MS = 200;

async function main() {
    // Imported after the env is loaded: the driver reads nothing from it, but
    // buildMongoUri does.
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(buildMongoUri(), {
        appName: 'kodus-script-purge-legacy-agent-sessions',
    });
    await client.connect();
    try {
        const sessions = client.db(mongoDatabaseName()).collection(COLLECTION);
        const cutoff = Date.now() - RETENTION_MS;

        // Last activity is epoch ms, at the top level or under sessionData,
        // depending on which writer produced the document.
        const stale = {
            updatedAt: { $exists: false },
            $or: [
                { timestamp: { $lt: cutoff } },
                { 'sessionData.lastActivityTimestamp': { $lt: cutoff } },
            ],
        };
        const undated = {
            'updatedAt': { $exists: false },
            'timestamp': { $exists: false },
            'sessionData.lastActivityTimestamp': { $exists: false },
        };

        const [total, legacy, toDelete, noDate] = await Promise.all([
            sessions.estimatedDocumentCount(),
            sessions.countDocuments({ updatedAt: { $exists: false } }),
            sessions.countDocuments(stale),
            sessions.countDocuments(undated),
        ]);
        console.log(
            JSON.stringify(
                {
                    collection: COLLECTION,
                    total,
                    withoutUpdatedAt: legacy,
                    staleLegacyToDelete: toDelete,
                    legacyWithNoDateLeftAlone: noDate,
                    cutoff: new Date(cutoff).toISOString(),
                    apply: APPLY,
                },
                null,
                2,
            ),
        );

        if (!APPLY) {
            console.log('Dry run: nothing deleted. Re-run with --apply.');
            return;
        }

        let deleted = 0;
        for (;;) {
            const ids = (
                await sessions
                    .find(stale, { projection: { _id: 1 } })
                    .limit(BATCH)
                    .toArray()
            ).map((doc) => doc._id);
            if (!ids.length) break;
            // `stale` again in the write: a session that got a message after
            // the read above is no longer stale and must survive.
            const result = await sessions.deleteMany({
                ...stale,
                _id: { $in: ids },
            });
            deleted += result.deletedCount;
            console.log(`deleted ${deleted} / ${toDelete}`);
            await new Promise((r) => setTimeout(r, PAUSE_MS));
        }
        console.log(`done: deleted ${deleted}`);
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
