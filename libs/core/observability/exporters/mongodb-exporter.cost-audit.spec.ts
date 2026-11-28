/**
 * Cost audit of the Kody Runtime's LLM cost: the billing spans (a span with
 * `gen_ai.usage.total_tokens`, the only record the Runtime cost reads) must
 * reach `observability_telemetry` exactly once. The Runtime read sums every
 * stored span and the exporter stores no span id, so a span written twice is
 * a call billed twice, and a span never written is a call the cost never sees.
 *
 * The collection is a stand-in that behaves like the driver over a collection
 * with its unique `_id` index: insertMany gives each document a client-side
 * `_id` (the driver mutates the documents it sends) and refuses a duplicate
 * `_id` (E11000). The WAL and the DLQ are real files in a temporary directory.
 *
 * Tests marked `it.failing` are KNOWN DEFECTS: they state the right behavior
 * and fail today.
 */
// The global jest setup replaces the logger module with a silent createLogger only;
// the exporter also needs the real deepSanitize it stores attributes through.
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
    deepSanitize: jest.requireActual('@libs/core/log/logger').deepSanitize,
}));

import { randomUUID } from 'crypto';
import { promises as fs, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { MongoDBExporter } from './mongodb-exporter';

type Stored = { _id: string; attributes: Record<string, unknown> };

/** A telemetry collection: unique `_id`, ids assigned on the client as the driver does. */
function telemetryCollection() {
    const docs: Stored[] = [];
    let failNext: ((batch: any[]) => Error | undefined) | undefined;
    return {
        docs,
        /** The next insertMany commits what the given hook lets through, then throws what it returns. */
        failNextWith(hook: (batch: any[]) => Error | undefined) {
            failNext = hook;
        },
        insertMany: jest.fn(async (batch: any[]) => {
            const hook = failNext;
            failNext = undefined;
            const error = hook?.(batch);
            const writeErrors: Array<{ index: number }> = [];
            const insertedIds: Record<number, string> = {};
            batch.forEach((doc, index) => {
                doc._id ??= randomUUID();
                const refusedByHook = (error as any)?.refuse?.includes(index);
                if (refusedByHook || docs.some((d) => d._id === doc._id)) {
                    writeErrors.push({ index });
                    return;
                }
                docs.push(structuredClone(doc));
                insertedIds[index] = doc._id;
            });
            // A bulk error names what it refused and what it committed, as the driver reports it.
            if (error) throw (error as any).refuse ? Object.assign(error, { writeErrors, result: { insertedIds } }) : error;
            if (writeErrors.length) throw Object.assign(new Error('E11000 duplicate key error'), { name: 'MongoBulkWriteError', code: 11000, writeErrors, result: { insertedIds } });
            return { insertedIds };
        }),
    };
}

const billingSpan = (callId: string) => ({
    name: 'runtime.intent',
    startTime: Date.parse('2026-11-10T12:00:00.000Z'),
    endTime: Date.parse('2026-11-10T12:00:02.000Z'),
    attributes: {
        callId,
        'organizationId': 'org-1',
        'runId': 'run-1',
        'gen_ai.usage.input_tokens': 1_000,
        'gen_ai.usage.output_tokens': 100,
        'gen_ai.usage.total_tokens': 1_100,
    },
    status: { code: 'ok' },
});

let dir: string;
function exporter(collection?: ReturnType<typeof telemetryCollection>) {
    const e = new MongoDBExporter({ batchSize: 1_000_000, flushIntervalMs: 60_000 });
    Object.assign(e as any, {
        walPath: join(dir, 'wal.jsonl'),
        walProcessingPath: join(dir, 'wal.jsonl.processing'),
        dlqPath: join(dir, 'dlq.jsonl'),
        collections: collection ? { logs: { insertMany: jest.fn() }, telemetry: collection } : null,
        handleConnectionError: jest.fn().mockResolvedValue(undefined),
        scheduleReconnect: jest.fn().mockResolvedValue(undefined),
    });
    return e as any;
}
const linesOf = async (path: string) => (await fs.readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
async function untilWalHas(n: number) {
    for (let i = 0; i < 600 && (await linesOf(join(dir, 'wal.jsonl'))) < n; i++) await new Promise((r) => setTimeout(r, 25));
}
const copiesOf = (collection: ReturnType<typeof telemetryCollection>, callId: string) => collection.docs.filter((d) => d.attributes.callId === callId).length;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kodus-cost-audit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a billing span reaches observability_telemetry exactly once', () => {
    // KNOWN DEFECT (cost-audit): a flush whose insertMany committed but whose answer was lost (no result, no writeErrors) re-buffers the batch with `_id` stripped, so the retry stores every span a second time.
    it.failing('L8: a flush that committed but lost its acknowledgement does not store the span again on retry', async () => {
        const collection = telemetryCollection();
        const e = exporter(collection);
        e.exportTelemetry(billingSpan('call-1'));
        await untilWalHas(1);

        collection.failNextWith(() => Object.assign(new Error('connection 3 to mongo:27017 closed'), { name: 'MongoNetworkError' }));
        await e.flushTelemetry(); // committed on the server; the driver throws
        await e.flushTelemetry(); // the retry

        expect(copiesOf(collection, 'call-1')).toBe(1);
    });

    // KNOWN DEFECT (cost-audit): after a partly failed flush the whole in-flight WAL (committed spans too) is merged back; a restart before the next good flush replays and re-inserts the committed ones.
    it.failing('L9: a restart after a partly failed flush does not store the committed span again', async () => {
        const collection = telemetryCollection();
        const before = exporter(collection);
        before.exportTelemetry(billingSpan('call-1'));
        before.exportTelemetry(billingSpan('call-2'));
        await untilWalHas(2);
        collection.failNextWith(() => Object.assign(new Error('write conflict'), { name: 'MongoBulkWriteError', refuse: [1] }));
        await before.flushTelemetry(); // call-1 committed, call-2 refused

        const after = exporter(collection); // the process restarts before the next flush
        await after.recoverFromWal();
        await after.flushTelemetry();

        expect({ call1: copiesOf(collection, 'call-1'), call2: copiesOf(collection, 'call-2') }).toEqual({ call1: 1, call2: 1 });
    });

    // KNOWN DEFECT (cost-audit): past 10 000 buffered billing spans the oldest 1 000 go to the DLQ file, which nothing reads back, and the next good flush deletes their WAL lines.
    it.failing('L10: every billing span exported while Mongo was unreachable is stored once it is back, even after a restart', async () => {
        const collection = telemetryCollection();
        const e = exporter(); // Mongo unreachable: no collections
        for (let i = 1; i <= 10_001; i++) e.exportTelemetry(billingSpan(`call-${i}`));
        await untilWalHas(10_001);

        e.collections = { logs: { insertMany: jest.fn() }, telemetry: collection }; // Mongo is back
        await e.flushTelemetry();
        const restarted = exporter(collection);
        await restarted.recoverFromWal();
        await restarted.flushTelemetry();

        expect(collection.docs.length).toBe(10_001);
    }, 60_000);
});
