/**
 * Integration tests for the MongoDB migration modules against a REAL Mongo, in a
 * throwaway database that is dropped after the run — so they never touch app
 * data. Skipped (with a warning) when no Mongo is reachable, so a laptop without
 * one still goes green; CI and the dev container run them for real.
 *
 * The load-bearing assertion is the cross-check: the backfilled `attributes.tu`
 * must deep-equal `deriveTu(rawAttributes)` — i.e. the migration's Mongo pipeline
 * produces byte-identical output to the TypeScript write path. That is the whole
 * "zero logic change" guarantee, verified end-to-end.
 */
import { Db, MongoClient } from 'mongodb';

import { deriveTu } from '@libs/core/log/token-usage-tu';

import { buildMongoUri } from './mongo-migration-client';
import {
    ensureTokenUsageIndexes,
    dropTokenUsageIndexes,
} from './token-usage/ensure-indexes';
import { backfillTokenUsageTu } from './token-usage/backfill-tu';
import { migrateKodyRulesOriginRequestType } from './kody-rules/migrate-origin-request-type';

const TEST_DB = 'kodus_migration_it';
const TELEMETRY = 'observability_telemetry';

let client: MongoClient | null = null;
let db: Db;
let available = false;

const ts = new Date('2026-06-15T12:00:00Z');

// Raw span attributes exactly as the exporter stores them (dotted keys).
function span(attrs: Record<string, any>) {
    return {
        attributes: { organizationId: 'org-it', ...attrs },
        timestamp: ts,
    };
}

const SEED_SPANS = [
    // byok gemini above the 200k tier threshold
    span({
        'gen_ai.usage.total_tokens': 300000,
        'gen_ai.usage.input_tokens': 250000,
        'gen_ai.usage.output_tokens': 50000,
        'gen_ai.response.model': 'google_gemini:gemini-2.5-pro',
        type: 'byok',
        prNumber: 7,
    }),
    // internal system-analysis run-name (sys=true) — excluded from byok=false view
    span({
        'gen_ai.usage.total_tokens': 1200,
        'gen_ai.usage.input_tokens': 1000,
        'gen_ai.usage.output_tokens': 200,
        'gen_ai.usage.reasoning_tokens': 80,
        'gen_ai.response.model': 'openai:gpt-5',
        type: 'system',
        'gen_ai.run.name': 'generateCodeSuggestions',
    }),
    // ordinary billable-view span
    span({
        'gen_ai.usage.total_tokens': 500,
        'gen_ai.usage.input_tokens': 400,
        'gen_ai.usage.output_tokens': 100,
        'gen_ai.response.model': 'claude-sonnet-5',
        type: 'system',
        'gen_ai.run.name': 'code-review-security',
    }),
    // wrapper span with NO usage — must be left unstamped
    span({ 'gen_ai.response.model': 'claude-sonnet-5', type: 'system' }),
];

beforeAll(async () => {
    try {
        client = new MongoClient(buildMongoUri(), {
            serverSelectionTimeoutMS: 2000,
        });
        await client.connect();
        await client.db().command({ ping: 1 });
        db = client.db(TEST_DB);
        await db.dropDatabase(); // clean slate
        available = true;
    } catch {
        available = false;
        // eslint-disable-next-line no-console
        console.warn(
            '[mongo-migrations.integration] no Mongo reachable — skipping. ' +
                'Set API_MG_DB_* / MONGODB_URI to run for real.',
        );
    }
});

afterAll(async () => {
    if (available && client) {
        await db.dropDatabase();
    }
    if (client) await client.close();
});

describe('token-usage migration (integration)', () => {
    it('creates covering indexes, drops dead ones, and is idempotent', async () => {
        if (!available) return;
        const c = db.collection(TELEMETRY);
        // Seed a legacy dead index to prove the drop.
        await c.createIndex(
            { 'attributes.organizationId': 1, createdAt: -1 },
            { name: 'attributes.organizationId_1_createdAt_-1' },
        );

        await ensureTokenUsageIndexes(db);
        await ensureTokenUsageIndexes(db); // idempotent — no throw

        const names = (await c.indexes()).map((i) => i.name);
        expect(names).toContain('tu_cover_byok');
        expect(names).toContain('tu_cover_sys');
        expect(names).not.toContain('attributes.organizationId_1_createdAt_-1');

        const byok = (await c.indexes()).find((i) => i.name === 'tu_cover_byok');
        expect(byok?.partialFilterExpression).toEqual({
            'attributes.tu.isByok': true,
        });

        await dropTokenUsageIndexes(db);
        const after = (await c.indexes()).map((i) => i.name);
        expect(after).not.toContain('tu_cover_byok');
        expect(after).not.toContain('tu_cover_sys');
    });

    it('backfills tu identical to deriveTu, skips usage-less spans, idempotent', async () => {
        if (!available) return;
        const c = db.collection(TELEMETRY);
        await c.deleteMany({});
        const res = await c.insertMany(SEED_SPANS.map((s) => ({ ...s })));
        const ids = Object.values(res.insertedIds);

        const first = await backfillTokenUsageTu(db, { sleepMs: 0, batch: 100 });
        expect(first.stamped).toBe(3); // the 3 with usage; wrapper skipped

        // The load-bearing check: pipeline output === write-path deriveTu output.
        const docs = await c.find({ _id: { $in: ids } }).toArray();
        for (const doc of docs) {
            const expected = deriveTu(doc.attributes);
            if (expected === null) {
                expect(doc.attributes.tu).toBeUndefined(); // wrapper span
            } else {
                expect(doc.attributes.tu).toEqual(expected);
            }
        }

        // Spot-check the tier-relevant fields survived (tier derived at read).
        const gemini = docs.find(
            (d) => d.attributes.tu?.model === 'gemini-2.5-pro',
        );
        expect(gemini?.attributes.tu).toMatchObject({
            isByok: true,
            sys: false,
            input: 250000,
            total: 300000,
        });

        const second = await backfillTokenUsageTu(db, { sleepMs: 0, batch: 100 });
        expect(second.stamped).toBe(0); // idempotent
    });
});

describe('kody-rules migration (integration)', () => {
    it('remaps legacy origin/requestType and is idempotent', async () => {
        if (!available) return;
        const c = db.collection('kodyRules');
        await c.deleteMany({});
        await c.insertOne({
            organizationId: 'org-it',
            rules: [
                { uuid: 'a', origin: 'generated' },
                { uuid: 'b', origin: 'user', sourcePath: '.cursor/rules/x.md' },
                { uuid: 'c', origin: 'user' },
                { uuid: 'd', requestType: 'memory_create' },
                { uuid: 'e', origin: 'manual', requestType: 'create' }, // already widened
            ],
        });

        const first = await migrateKodyRulesOriginRequestType(db);
        expect(first.docsUpdated).toBe(1);
        expect(first.rulesMigrated).toBe(4); // a,b,c,d change; e untouched

        const doc = await c.findOne({ organizationId: 'org-it' });
        const byUuid = Object.fromEntries(
            (doc!.rules as any[]).map((r) => [r.uuid, r]),
        );
        expect(byUuid.a.origin).toBe('past_reviews');
        expect(byUuid.b.origin).toBe('repo_file_sync');
        expect(byUuid.c.origin).toBe('manual');
        expect(byUuid.d.requestType).toBe('create');
        expect(byUuid.e.origin).toBe('manual');

        const second = await migrateKodyRulesOriginRequestType(db);
        expect(second.rulesMigrated).toBe(0); // idempotent
    });
});
