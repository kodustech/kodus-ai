import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { type Db, MongoClient } from 'mongodb';
import type { ModelTurnResponse } from '@libs/runtime/contracts/model-turn';
import {
    MongoModelTurnReceipts,
    MODEL_TURN_RECEIPTS_COLLECTION,
} from './mongo-model-turn-receipts.store';

// Explicitly opt in against an isolated local/fixture Mongo, using the same
// URI variable as the existing real-Mongo budget integration suite. No app
// database name is accepted: every case owns and removes a random test DB.
const url = process.env.RUNTIME_IT_MONGO_URL ?? '';
const enabled =
    process.env.RUNTIME_RECEIPTS_IT_ISOLATED === '1' &&
    process.env.SKIP_INTEGRATION !== 'true';
const DB_PREFIX = 'it_runtime_receipts_';
function requireFixtureServer() {
    if (!url.startsWith('mongodb://'))
        throw Error(
            'Receipt integration requires an isolated fixture Mongo URI',
        );
    const authority = url
        .slice('mongodb://'.length)
        .split(/[/?]/, 1)[0]
        .split('@')
        .at(-1)!;
    const local = authority.split(',').every((part) => {
        const host = part.startsWith('[')
            ? part.slice(0, part.indexOf(']') + 1)
            : part.split(':', 1)[0];
        return /^(?:localhost|127\.0\.0\.1|\[::1\]|runtime-mongo|db_mongodb|mongo-fixture|kody-receipts-mongo-[a-z0-9-]+)$/.test(
            host,
        );
    });
    if (!local)
        throw Error('Receipt integration refuses a non-fixture Mongo host');
}
const digest = (text: string) =>
    createHash('sha256').update(text).digest('hex');
const response = (): ModelTurnResponse => ({
    v: 1,
    scope: { runId: randomUUID(), attempt: 1, turnId: randomUUID() },
    generation: {
        content: [{ type: 'text', text: 'bounded synthetic fixture' }],
        finishReason: { unified: 'stop' },
        usage: {
            reported: true,
            inputTokens: { total: 10 },
            outputTokens: { total: 2 },
        },
        warnings: [],
    },
    budget: { remainingTokens: 88, usageBasis: 'provider_reported' },
});

(enabled ? describe : describe.skip)(
    'MongoModelTurnReceipts (integration, isolated real Mongo)',
    () => {
        let client: MongoClient;
        let db: Db;
        const options = {
            serverSelectionTimeoutMS: 4000,
            connectTimeoutMS: 4000,
            waitQueueTimeoutMS: 2000,
            maxPoolSize: 2,
            runtimeAdapters: { os },
        };
        beforeAll(async () => {
            requireFixtureServer();
            client = await MongoClient.connect(url, options);
        });
        beforeEach(() => {
            db = client.db(`${DB_PREFIX}${randomUUID().replaceAll('-', '')}`);
        });
        afterEach(async () => {
            if (db) {
                if (!db.databaseName.startsWith(DB_PREFIX))
                    throw Error('Refusing to clean a non-fixture database');
                await db.dropDatabase();
            }
        });
        afterAll(async () => {
            await client?.close();
        });
        const adapter = () => new MongoModelTurnReceipts(async () => db);
        const expiry = () => new Date(Date.now() + 30 * 86400_000);

        it('grants exactly one fresh turn across 16 concurrent adapter instances and keeps the completed response after a new client connects', async () => {
            const key = digest('concurrent-turn'),
                fingerprint = digest('closed validated request');
            const results = await Promise.all(
                Array.from({ length: 16 }, () =>
                    adapter().claim(key, fingerprint, expiry()),
                ),
            );
            expect(
                results.filter((result) => result.fresh === true),
            ).toHaveLength(1);
            expect(
                results.filter((result) => result.fresh === false),
            ).toHaveLength(15);
            expect(
                await db
                    .collection(MODEL_TURN_RECEIPTS_COLLECTION)
                    .countDocuments(),
            ).toBe(1);
            const answer = response();
            await adapter().complete(key, fingerprint, answer);
            const secondClient = await MongoClient.connect(url, options);
            try {
                const restarted = new MongoModelTurnReceipts(async () =>
                    secondClient.db(db.databaseName),
                );
                expect(
                    await restarted.claim(key, fingerprint, expiry()),
                ).toEqual({ fresh: false, fingerprint, response: answer });
            } finally {
                await secondClient.close();
            }
        });
        it('keeps an unknown/pending turn non-fresh after recreation and never replaces a fingerprint or completed response', async () => {
            const key = digest('pending-turn'),
                fingerprint = digest('original request');
            expect(await adapter().claim(key, fingerprint, expiry())).toEqual({
                fresh: true,
            });
            expect(await adapter().claim(key, fingerprint, expiry())).toEqual({
                fresh: false,
                fingerprint,
            });
            expect(
                await adapter().claim(key, digest('changed request'), expiry()),
            ).toEqual({ fresh: false, fingerprint });
            await expect(
                adapter().complete(key, digest('changed request'), response()),
            ).rejects.toThrow('conflict');
            const answer = response();
            await adapter().complete(key, fingerprint, answer);
            await expect(
                adapter().complete(key, fingerprint, response()),
            ).rejects.toThrow('conflict');
            expect(await adapter().claim(key, fingerprint, expiry())).toEqual({
                fresh: false,
                fingerprint,
                response: answer,
            });
        });
        it('creates the real TTL index and records the expiration without waiting for the asynchronous Mongo TTL monitor', async () => {
            const key = digest('ttl-turn'),
                until = expiry();
            await adapter().claim(key, digest('ttl request'), until);
            const collection = db.collection(MODEL_TURN_RECEIPTS_COLLECTION);
            const ttl = (await collection.indexes()).filter(
                (index) => index.expireAfterSeconds === 0,
            );
            expect(ttl.map((index) => index.key)).toEqual([{ expiresAt: 1 }]);
            expect(
                (await collection.findOne({ _id: key as any }))?.expiresAt,
            ).toEqual(until);
        });
        it('does not persist an oversized response and leaves the turn pending', async () => {
            const key = digest('large-turn'),
                fingerprint = digest('large request');
            await adapter().claim(key, fingerprint, expiry());
            const answer = response();
            answer.generation.content = [
                { type: 'text', text: 'x'.repeat(1_000_001) },
            ];
            await expect(
                adapter().complete(key, fingerprint, answer),
            ).rejects.toThrow('too large');
            expect(await adapter().claim(key, fingerprint, expiry())).toEqual({
                fresh: false,
                fingerprint,
            });
        });
    },
);
