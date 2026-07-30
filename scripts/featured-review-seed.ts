#!/usr/bin/env npx ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Featured review seed tool.
 *
 * Ships the curated public-demo reviews (the cards under "Try a featured
 * PR") to any environment as a committed snapshot, so prod serves the
 * exact same cached reviews we validated locally — no need to re-run the
 * reviews against an LLM at deploy time.
 *
 * Round-trips the `featured_public_reviews` Mongo collection through a
 * versioned JSON fixture (scripts/seed/featured-reviews.json by default):
 *
 *   pnpm run featured-review:seed --export      # dump current Mongo -> JSON
 *   pnpm run featured-review:seed                # upsert JSON -> Mongo
 *
 * Options:
 *   --export            Read Mongo and (re)write the fixture instead of importing.
 *   --file=<path>       Fixture path (default: scripts/seed/featured-reviews.json).
 *   --env=<path>        Path to .env (default: ./.env).
 *   --prune             On import, unpublish slugs in Mongo that aren't in the fixture.
 *   --dry-run           Print what would change without writing.
 */

import * as dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';
import { pickSnapshot } from './featured-review-snapshot';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.split('=').slice(1).join('=');
};
const has = (name: string) => argv.includes(`--${name}`);

const envArg = flag('env');
const envPath = envArg
    ? path.resolve(envArg)
    : path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const fixturePath = path.resolve(
    flag('file') ?? path.resolve(__dirname, 'seed/featured-reviews.json'),
);

const COLLECTION = 'featured_public_reviews';

function buildMongoUri(): string {
    if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
    const host = process.env.API_MG_DB_HOST ?? 'localhost';
    const port = process.env.API_MG_DB_PORT ?? '27017';
    const user = process.env.API_MG_DB_USERNAME;
    const pass = process.env.API_MG_DB_PASSWORD;
    const auth = user && pass ? `${user}:${encodeURIComponent(pass)}@` : '';
    const db = process.env.API_MG_DB_DATABASE ?? 'kodus';
    return `mongodb://${auth}${host}:${port}/${db}?authSource=admin`;
}

async function exportFixture(db: any, dryRun: boolean) {
    const docs = await db
        .collection(COLLECTION)
        .find({})
        .sort({ sortOrder: 1, createdAt: -1 })
        .toArray();

    const snapshot = docs.map(pickSnapshot);
    const json = JSON.stringify(snapshot, null, 2) + '\n';

    if (dryRun) {
        console.log(
            `[dry-run] would write ${snapshot.length} review(s) to ${fixturePath}`,
        );
        console.log(snapshot.map((d: any) => `  - ${d.slug}`).join('\n'));
        return;
    }

    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, json);
    console.log(
        JSON.stringify(
            {
                ok: true,
                action: 'export',
                file: fixturePath,
                count: snapshot.length,
                slugs: snapshot.map((d: any) => d.slug),
            },
            null,
            2,
        ),
    );
}

async function importFixture(db: any, prune: boolean, dryRun: boolean) {
    if (!fs.existsSync(fixturePath)) {
        console.error(`Fixture not found: ${fixturePath}`);
        process.exit(2);
    }
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const reviews: any[] = JSON.parse(raw);
    if (!Array.isArray(reviews)) {
        console.error('Fixture must be a JSON array of featured reviews.');
        process.exit(3);
    }

    const coll = db.collection(COLLECTION);
    const now = new Date();
    const fixtureSlugs = new Set<string>();
    const results: any[] = [];

    for (const review of reviews) {
        const snap = pickSnapshot(review);
        if (!snap.slug) {
            console.error('Skipping a fixture entry without a slug.');
            continue;
        }
        fixtureSlugs.add(snap.slug);

        if (dryRun) {
            results.push({ slug: snap.slug, action: 'upsert (dry-run)' });
            continue;
        }

        const res = await coll.findOneAndUpdate(
            { slug: snap.slug },
            {
                $set: { ...snap, updatedAt: now },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true, returnDocument: 'after' },
        );
        results.push({
            slug: snap.slug,
            inserted: res?.lastErrorObject?.upserted ? true : false,
        });
    }

    let pruned: string[] = [];
    if (prune) {
        const existing: any[] = await coll
            .find({ published: true })
            .project({ slug: 1 })
            .toArray();
        const stale = existing
            .map((d) => d.slug)
            .filter((s) => !fixtureSlugs.has(s));
        if (stale.length && !dryRun) {
            await coll.updateMany(
                { slug: { $in: stale } },
                { $set: { published: false, updatedAt: now } },
            );
        }
        pruned = stale;
    }

    console.log(
        JSON.stringify(
            {
                ok: true,
                action: dryRun ? 'import (dry-run)' : 'import',
                file: fixturePath,
                upserted: results,
                pruned,
            },
            null,
            2,
        ),
    );
}

async function main() {
    const dryRun = has('dry-run');
    const uri = buildMongoUri();
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(process.env.API_MG_DB_DATABASE ?? 'kodus');
    try {
        if (has('export')) {
            await exportFixture(db, dryRun);
        } else {
            await importFixture(db, has('prune'), dryRun);
        }
    } finally {
        await client.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
