/**
 * @file mongodb-exporter.unit.test.ts
 *
 * Unit tests for MongoDBExporter — focused on the BSON-safety guard:
 * callers frequently pass shapes with circular refs (Axios errors with
 * config↔request↔response, Mongoose documents, Error.cause loops). The
 * exporter must sanitize them before pushing into the buffer, otherwise
 * `insertMany` blows up with "Cannot convert circular structure to BSON"
 * and the entire batch is lost.
 */

/* eslint-disable @typescript-eslint/naming-convention --
 * Tests construct object literals that mirror what the MongoDB driver
 * actually returns / accepts: `_id` (BSON-mandated field name) and
 * numeric-index keys on `MongoBulkWriteError.result.insertedIds` (the
 * driver's shape is literally `{ 0: ObjectId, 2: ObjectId }`).
 * Renaming would diverge the test fixtures from the real driver. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MongoDBExporter } from '../../src/observability/exporters/mongodb-exporter.js';

const buildExporter = () =>
    new MongoDBExporter({
        // High batch size so we never trigger flushLogs() during the test.
        batchSize: 999_999,
        connectionString: 'mongodb://localhost:27017/kodus-test',
        database: 'kodus-test',
    });

/**
 * Walks an object graph the way BSON serialization would, looking for
 * back-edges. Returns true if any cycle exists. Used by the in-memory
 * insertMany mock to faithfully reproduce the production failure mode
 * ("Cannot convert circular structure to BSON") without needing a real
 * MongoDB client in the test loop.
 */
function hasCircular(obj: any, seen: WeakSet<object> = new WeakSet()): boolean {
    if (obj === null || typeof obj !== 'object') return false;
    // BSON natively serializes these — don't follow their internal refs.
    if (obj instanceof Date) return false;
    if (obj instanceof RegExp) return false;
    if (seen.has(obj)) return true;
    seen.add(obj);
    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (hasCircular(item, seen)) return true;
        }
        return false;
    }
    for (const key of Object.keys(obj)) {
        try {
            if (hasCircular(obj[key], seen)) return true;
        } catch {
            // Some getters throw — treat as opaque.
        }
    }
    return false;
}

/**
 * Mimics the MongoDB driver's insertMany. Fails the WHOLE batch (like real
 * BSON does) the moment any doc contains a cycle. Captures successful
 * inserts so tests can assert on what landed in the "database".
 */
function makeMockCollections() {
    const insertedBatches: any[][] = [];
    const failedBatches: any[][] = [];
    const insertMany = vi.fn(async (docs: any[]) => {
        for (const doc of docs) {
            if (hasCircular(doc)) {
                failedBatches.push(docs);
                throw new Error('Cannot convert circular structure to BSON');
            }
        }
        insertedBatches.push(docs);
        return { acknowledged: true, insertedCount: docs.length };
    });
    return {
        collections: {
            logs: { insertMany },
            telemetry: { insertMany: vi.fn() },
        },
        insertedBatches,
        failedBatches,
        insertMany,
    };
}

describe('MongoDBExporter — circular ref safety', () => {
    it('replaces circular references in metadata/attributes with [Circular] before buffering', async () => {
        const exporter = buildExporter();

        // Axios-style cycle: config ↔ request
        const config: any = { url: '/api', method: 'GET' };
        const request: any = { config };
        config.request = request;

        await exporter.exportLog('error', 'request failed', {
            component: 'axios-client',
            organizationId: 'org-1',
            payload: config, // contains the cycle
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);

        // Round-trips through JSON without throwing — no cycles remain.
        expect(() => JSON.stringify(buffer[0])).not.toThrow();

        const serialized = JSON.stringify(buffer[0]);
        expect(serialized).toContain('[Circular]');
    });

    it('drops sensitive keys via the shared deepSanitize helper (defense in depth)', async () => {
        const exporter = buildExporter();

        await exporter.exportLog('info', 'webhook received', {
            component: 'webhook',
            organizationId: 'org-1',
            apiKey: 'sk-very-secret-do-not-log',
            password: 'hunter2',
            nested: { token: 'jwt-stuff' },
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        const serialized = JSON.stringify(buffer[0]);

        // None of the secret values leak into the persisted payload.
        expect(serialized).not.toContain('sk-very-secret-do-not-log');
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('jwt-stuff');
    });

    it('preserves Date instances (BSON understands Date directly)', async () => {
        const exporter = buildExporter();
        const ts = new Date('2026-04-30T12:00:00Z');

        await exporter.exportLog('info', 'ping', {
            component: 'cron',
            occurredAt: ts,
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        // The attribute came through as a Date, not as a generic object —
        // otherwise BSON would accept it but the time-series collection
        // would no longer be able to query/sort by it.
        expect(buffer[0].attributes.occurredAt).toBeInstanceOf(Date);
        expect(buffer[0].attributes.occurredAt.getTime()).toBe(ts.getTime());
    });
});

/**
 * Fix A — sanitize the full logItem before pushing into the buffer.
 *
 * The shipped fix in 4dedc831a sanitizes metadata + attributes but leaves
 * gaps elsewhere: `error.message` (assignable to a non-string in custom
 * Error subclasses), top-level identifier fields like `executionId`,
 * `sessionId`, `correlationId`, `tenantId` (typed as string but not
 * enforced at runtime), and any future field added to the logItem shape.
 *
 * The robust answer is to sanitize the whole object once, just before it
 * lands in the buffer — so no field can carry a cycle into insertMany.
 */
describe('MongoDBExporter — full logItem sanitization (Fix A)', () => {
    it('sanitizes a cycle attached to error.message (atypical Error subclasses)', async () => {
        const exporter = buildExporter();

        const cycle: any = { a: 1 };
        cycle.self = cycle;

        const err = new Error('boom');
        // Custom Error subclasses in the wild occasionally overwrite
        // `message` with a structured payload — TypeScript doesn't enforce
        // it at runtime, and the exporter copies the field straight into
        // the logItem.
        (err as any).message = cycle;

        await exporter.exportLog('error', 'request failed', undefined, err);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);
        expect(() => JSON.stringify(buffer[0])).not.toThrow();
        expect(JSON.stringify(buffer[0])).toContain('[Circular]');
    });

    it('sanitizes a cycle assigned to executionId (top-level identifier fields)', async () => {
        const exporter = buildExporter();

        const cycle: any = { foo: 1 };
        cycle.back = cycle;

        await exporter.exportLog('info', 'event', {
            component: 'service-x',
            executionId: cycle, // bypasses the per-field deepSanitize that
            // only covers metadata/attributes today.
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);
        expect(() => JSON.stringify(buffer[0])).not.toThrow();
    });

    it('sanitizes a cycle assigned to correlationId', async () => {
        const exporter = buildExporter();

        const cycle: any = { x: 1 };
        cycle.cycle = cycle;

        await exporter.exportLog('info', 'event', {
            component: 'service-x',
            correlationId: cycle,
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);
        expect(() => JSON.stringify(buffer[0])).not.toThrow();
    });

    it('produces a logItem that the mock insertMany can serialize end-to-end', async () => {
        // End-to-end: build a context that today would explode at insertMany.
        const exporter = buildExporter();
        const { collections, insertedBatches, failedBatches } =
            makeMockCollections();
        (exporter as any).collections = collections;

        const cycle: any = { hint: 'boom' };
        cycle.parent = cycle;

        await exporter.exportLog('error', 'cycle everywhere', {
            component: 'svc',
            executionId: cycle,
            correlationId: cycle,
        } as any);

        await (exporter as any).flushLogs();

        // No batch failed (the fix means insertMany only sees clean docs)
        // and exactly one batch with one doc was inserted successfully.
        expect(failedBatches).toHaveLength(0);
        expect(insertedBatches).toHaveLength(1);
        expect(insertedBatches[0]).toHaveLength(1);
    });
});

/**
 * Fix B — isolate poisoned logs from healthy ones at flush time.
 *
 * Even after Fix A, fringe non-serializable payloads (BigInt, Symbol keys,
 * getters that throw, etc.) can sneak past deepSanitize. The current catch
 * block in flushLogs() puts the failed logsToFlush back into the buffer
 * verbatim — so the same poisoned entry keeps blowing up every subsequent
 * flush and dragging the rest of the batch with it. That's the loop that
 * generated 24.7k "Failed to flush logs to MongoDB" errors in a 24h window
 * in prod. The exporter must:
 *
 *   1. Either pre-screen each log so the bad ones never reach insertMany, or
 *   2. On insertMany failure, drop the offending entries and retry the rest.
 *
 * The contract these tests enforce is the same either way: the healthy
 * majority of a batch must make it to the DB, and the poisoned entry must
 * NOT come back into the buffer on the next tick.
 */
describe('MongoDBExporter — poisoned batch isolation (Fix B)', () => {
    it('persists healthy logs even when one entry in the batch is non-serializable', async () => {
        const exporter = buildExporter();
        const { collections, insertedBatches } = makeMockCollections();
        (exporter as any).collections = collections;

        // Inject 4 healthy logs + 1 poisoned log directly into the buffer
        // (bypassing exportLog's sanitization is intentional here — we're
        // proving the flush path itself is resilient).
        const poisoned: any = { name: 'BoomError', message: 'boom' };
        poisoned.self = poisoned;

        const healthy = (id: string) => ({
            timestamp: new Date(),
            level: 'info',
            message: `msg-${id}`,
            component: 'test',
            correlationId: id,
            tenantId: 'tenant-a',
            metadata: { component: 'test', level: 'info' },
            attributes: { id },
            createdAt: new Date(),
        });

        (exporter as any).logBuffer = [
            healthy('a'),
            healthy('b'),
            { ...healthy('c'), error: poisoned }, // poisoned entry
            healthy('d'),
            healthy('e'),
        ];

        await (exporter as any).flushLogs();

        // The 4 healthy logs made it to "the DB" across one or more calls.
        const totalInserted = insertedBatches.reduce(
            (n, batch) => n + batch.length,
            0,
        );
        expect(totalInserted).toBe(4);
    });

    it('does NOT push a poisoned log back into the buffer (no infinite-loop)', async () => {
        const exporter = buildExporter();
        const { collections } = makeMockCollections();
        (exporter as any).collections = collections;

        const poisoned: any = { name: 'BoomError', message: 'boom' };
        poisoned.self = poisoned;

        const healthy = {
            timestamp: new Date(),
            level: 'info' as const,
            message: 'msg',
            component: 'test',
            correlationId: 'cid',
            tenantId: 'tenant-a',
            metadata: { component: 'test', level: 'info' },
            attributes: {},
            createdAt: new Date(),
        };

        (exporter as any).logBuffer = [
            healthy,
            { ...healthy, error: poisoned },
        ];

        await (exporter as any).flushLogs();

        const bufferAfter = (exporter as any).logBuffer as any[];
        // The poisoned entry must not survive the flush — otherwise the
        // next tick re-runs the same failure forever.
        const bufferHasPoisoned = bufferAfter.some(
            (log: any) => log.error === poisoned,
        );
        expect(bufferHasPoisoned).toBe(false);
    });
});

/**
 * Faithful mock of `collection.insertMany` with `ordered: false`.
 *
 *  - Tracks `_id`s that already "committed" to the database across
 *    consecutive flushes.
 *  - Real driver behaviour: with `ordered: false`, every doc is
 *    attempted; collisions surface as `BulkWriteError` whose
 *    `.result.insertedIds` enumerates the IDs that DID land and
 *    `.writeErrors[].index` enumerates the ones that didn't.
 *  - Synthetic docs only — no customer data. Each call to
 *    `nextSyntheticId()` returns a fresh BSON-like 24-hex string.
 *
 * This mock is what makes the issue #1106 regression tests possible:
 * the test can call `flushTelemetry` twice in a row and watch whether
 * the SECOND call attempts to re-insert any `_id` that the FIRST call
 * already committed. Before the fix, that's exactly the E11000 loop
 * the production worker was caught in.
 */
function makeStatefulInsertMany(
    opts: {
        failIndicesOnFirstCall?: number[];
    } = {},
) {
    const committedIds = new Set<string>();
    const callLog: Array<{
        docs: any[];
        ids: Array<string | undefined>;
        threw: boolean;
        errorName?: string;
    }> = [];

    const insertMany = vi.fn(async (docs: any[], options?: any) => {
        const ordered = options?.ordered !== false;
        const insertedIds: Record<number, string> = {};
        const writeErrors: Array<{
            index: number;
            code: number;
            errmsg: string;
        }> = [];

        const firstCall = callLog.length === 0;
        const failureSet = firstCall
            ? new Set(opts.failIndicesOnFirstCall ?? [])
            : new Set<number>();

        docs.forEach((doc, idx) => {
            // Pre-flight BSON check — match real driver behaviour.
            if (hasCircular(doc)) {
                if (ordered) {
                    callLog.push({
                        docs,
                        ids: docs.map((d) => d?._id),
                        threw: true,
                        errorName: 'BSONError',
                    });
                    throw new Error(
                        'Cannot convert circular structure to BSON',
                    );
                }
                writeErrors.push({
                    index: idx,
                    code: 0,
                    errmsg: 'Cannot convert circular structure to BSON',
                });
                return;
            }

            const explicitFail = failureSet.has(idx);
            const dupId =
                typeof doc?._id === 'string' && committedIds.has(doc._id);

            if (explicitFail) {
                writeErrors.push({
                    index: idx,
                    code: 121,
                    errmsg: 'simulated server-side rejection',
                });
                return;
            }
            if (dupId) {
                writeErrors.push({
                    index: idx,
                    code: 11000,
                    errmsg: `E11000 duplicate key error: { _id: '${doc._id}' }`,
                });
                return;
            }

            // Commit. Generate a server-side _id if the doc didn't bring one.
            const idToUse: string =
                typeof doc?._id === 'string'
                    ? doc._id
                    : `oid-server-${committedIds.size + idx}`;
            committedIds.add(idToUse);
            insertedIds[idx] = idToUse;
        });

        callLog.push({
            docs,
            ids: docs.map((d) => d?._id),
            threw: writeErrors.length > 0,
            errorName:
                writeErrors.length > 0 ? 'MongoBulkWriteError' : undefined,
        });

        if (writeErrors.length === 0) {
            return {
                acknowledged: true,
                insertedCount: Object.keys(insertedIds).length,
                insertedIds,
            };
        }

        // Throw the shape the real driver throws.
        const bulkErr = new Error(
            `BulkWriteError: ${writeErrors.length} write error${writeErrors.length === 1 ? '' : 's'}`,
        ) as any;
        bulkErr.name = 'MongoBulkWriteError';
        bulkErr.result = { insertedIds };
        bulkErr.writeErrors = writeErrors;
        bulkErr.code = writeErrors[0].code;
        throw bulkErr;
    });

    return { insertMany, committedIds, callLog };
}

/**
 * Coverage for GH issue #1106
 *
 * Before this fix, flushTelemetry mirrored the unsafe pre-fix shape of
 * flushLogs:
 *  - No JSON.stringify pre-screen → one circular span poisoned the
 *    whole batch.
 *  - Failed batch was unshifted back with original `_id` values →
 *    items already committed on the server triggered E11000 forever.
 */
describe('MongoDBExporter — flushTelemetry poison + retry safety (issue #1106)', () => {
    const buildTelemetryItem = (id: string, extra: Record<string, any> = {}) =>
        ({
            traceId: `trace-${id}`,
            spanId: `span-${id}`,
            name: 'llm.generate',
            startTime: Date.now(),
            endTime: Date.now() + 10,
            attributes: { tenantId: 'tenant-a' },
            ...extra,
        }) as any;

    it('drops non-serializable critical spans instead of poisoning the batch', async () => {
        const exporter = buildExporter();
        const { collections, insertedBatches } = makeMockCollections();
        // Re-use the logs.insertMany mock for telemetry so we get the
        // same circular-detection behaviour the test file already wires.
        (exporter as any).collections = {
            ...collections,
            telemetry: collections.logs,
        };

        const poisoned: any = buildTelemetryItem('poison');
        poisoned.attributes.self = poisoned; // cycle into BSON

        (exporter as any).criticalTelemetryBuffer = [
            buildTelemetryItem('a'),
            poisoned,
            buildTelemetryItem('b'),
        ];

        await (exporter as any).flushTelemetry();

        // Only the two healthy items reach the "DB".
        const totalInserted = insertedBatches.reduce(
            (n, batch) => n + batch.length,
            0,
        );
        expect(totalInserted).toBe(2);

        // Poisoned span must NOT be re-buffered (no infinite loop).
        const bufferAfter = (exporter as any).criticalTelemetryBuffer as any[];
        const hasPoison = bufferAfter.some(
            (it: any) => it?.attributes?.self === poisoned,
        );
        expect(hasPoison).toBe(false);
    });

    it('strips _id and re-buffers only items not committed by the server', async () => {
        const exporter = buildExporter();

        // Simulate a partial-commit failure: 3 items go in, the driver
        // commits indices [0, 2] and reports index [1] as failed. The
        // exporter should re-buffer index [1] WITHOUT its original `_id`
        // so the retry asks Mongo to generate a fresh id — killing the
        // E11000 loop documented in the issue.
        const committedId0 = 'oid-already-saved-0';
        const committedId2 = 'oid-already-saved-2';
        const failedId1 = 'oid-server-rejected-1';

        const bulkError: any = new Error('BulkWriteError');
        (bulkError as any).result = {
            insertedIds: { 0: committedId0, 2: committedId2 },
        };
        (bulkError as any).writeErrors = [
            { index: 1, code: 11000, errmsg: 'duplicate key' },
        ];

        const telemetryInsertMany = vi.fn(async () => {
            throw bulkError;
        });
        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: { insertMany: telemetryInsertMany },
        };

        (exporter as any).normalTelemetryBuffer = [
            buildTelemetryItem('a', { _id: committedId0 }),
            buildTelemetryItem('b', { _id: failedId1 }),
            buildTelemetryItem('c', { _id: committedId2 }),
        ];

        await (exporter as any).flushTelemetry();

        const bufferAfter = (exporter as any).normalTelemetryBuffer as any[];

        // Exactly one item retried — the one the server actually
        // rejected. Anything else is the old E11000-loop regression.
        expect(bufferAfter).toHaveLength(1);
        expect(bufferAfter[0].spanId).toBe('span-b');

        // The retry MUST NOT carry the original client-side `_id`,
        // otherwise the next attempt collides with whatever sibling
        // doc the server committed under that id earlier.
        expect(bufferAfter[0]._id).toBeUndefined();
    });

    it('REGRESSION: two consecutive flushes never emit E11000 for the same _id (issue #1106 Bug 2)', async () => {
        // This is the precise loop that hit prod. Setup:
        //   - 5 synthetic telemetry items in the buffer, each with its
        //     own client-side _id.
        //   - First flush: server commits indices [0, 2, 4] and rejects
        //     index [1] (simulated server-side rejection, e.g. document
        //     too large). Without the fix, the catch block re-buffers
        //     ALL 5 items with their ORIGINAL _ids.
        //   - Second flush: would attempt to re-insert ids 0/2/4 →
        //     three E11000 errors. The retry loop dominates the worker
        //     error log.
        // After the fix, the second flush MUST NOT touch ids 0/2/4 and
        // MUST send each retried item without an _id (so the server
        // gets to generate a fresh one).
        const exporter = buildExporter();
        const { insertMany, callLog, committedIds } = makeStatefulInsertMany({
            failIndicesOnFirstCall: [1],
        });
        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: { insertMany },
        };

        const buildItem = (i: number) =>
            ({
                _id: `oid-client-${i}`,
                traceId: `trace-${i}`,
                spanId: `span-${i}`,
                name: 'llm.generate',
                startTime: Date.now(),
                endTime: Date.now() + 10,
                attributes: { i },
            }) as any;

        (exporter as any).normalTelemetryBuffer = [
            buildItem(0),
            buildItem(1),
            buildItem(2),
            buildItem(3),
            buildItem(4),
        ];

        // First flush — first call to insertMany throws MongoBulkWriteError.
        await (exporter as any).flushTelemetry();

        // Sanity: server "committed" 4 of the 5 (everything except idx 1).
        expect(committedIds.size).toBe(4);
        expect(callLog).toHaveLength(1);
        expect(callLog[0].threw).toBe(true);

        // The fix must leave a buffer of length 1 (only idx 1) and
        // that survivor must have its _id stripped.
        const bufferAfterFirst = (exporter as any)
            .normalTelemetryBuffer as any[];
        expect(bufferAfterFirst).toHaveLength(1);
        expect(bufferAfterFirst[0].spanId).toBe('span-1');
        expect(bufferAfterFirst[0]._id).toBeUndefined();

        // Second flush — the regression test. With the fix, the retry
        // sends ONE doc, no _id, no collision. Without the fix,
        // insertMany would be called with the original 5 _ids (or
        // with the survivor batch + stale ids), producing E11000s
        // for at least one already-committed id.
        await (exporter as any).flushTelemetry();

        expect(callLog).toHaveLength(2);
        const secondCallIds = callLog[1].ids;
        expect(secondCallIds).toHaveLength(1);
        expect(secondCallIds[0]).toBeUndefined();

        // The real assertion: the retry call did NOT include any _id
        // that was already committed in call #1.
        for (const id of secondCallIds) {
            if (typeof id === 'string') {
                expect(committedIds.has(id)).toBe(false);
            }
        }
        expect(callLog[1].threw).toBe(false);

        // Buffer must be empty now — everything either committed or
        // was a permanent failure caught by the writeError path.
        expect((exporter as any).normalTelemetryBuffer).toHaveLength(0);
    });

    it('REGRESSION: a circular span never poisons the rest of the batch across flushes (issue #1106 Bug 1)', async () => {
        // Exact prod symptom: a span with a circular ref enters the
        // telemetry buffer. Without the fix, every subsequent flush
        // attempts to serialize the whole batch and throws BSON,
        // dropping everything healthy alongside it.
        //
        // Buffer: 3 healthy + 1 circular. With the fix, two flushes
        // in a row succeed (drop the bad one, commit the rest, never
        // re-introduce the bad one).
        const exporter = buildExporter();
        const { insertMany, callLog, committedIds } = makeStatefulInsertMany();
        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: { insertMany },
        };

        const buildItem = (i: number) =>
            ({
                _id: `oid-clean-${i}`,
                traceId: `t-${i}`,
                spanId: `s-${i}`,
                name: 'llm.generate',
                startTime: Date.now(),
                endTime: Date.now() + 1,
                attributes: { i },
            }) as any;

        const circular: any = buildItem(99);
        circular.attributes.self = circular;

        (exporter as any).criticalTelemetryBuffer = [
            buildItem(0),
            buildItem(1),
            circular,
            buildItem(2),
        ];

        await (exporter as any).flushTelemetry();

        // The 3 healthy items reach the DB; the circular one is
        // dropped before insertMany ever sees it.
        expect(committedIds.size).toBe(3);
        // Real driver wasn't asked to swallow the poison — only the 3
        // healthy items reached insertMany.
        expect(callLog).toHaveLength(1);
        expect(callLog[0].docs).toHaveLength(3);
        expect(callLog[0].threw).toBe(false);
        // Critical buffer must be empty (nothing re-buffered).
        expect((exporter as any).criticalTelemetryBuffer).toHaveLength(0);

        // Second flush with an empty buffer is a no-op — proves the
        // bad item didn't sneak back in to re-poison the next batch.
        await (exporter as any).flushTelemetry();
        expect(callLog).toHaveLength(1); // unchanged
    });

    it('falls back to re-buffering the whole sanitized batch on a pre-flight error (no signal)', async () => {
        // When insertMany fails BEFORE reaching the server — e.g. a
        // BSON-encoder throw — neither `result.insertedIds` nor
        // `writeErrors` are present. Guarded re-buffer must put the
        // whole batch back (still `_id`-stripped) so nothing is lost
        // by accident.
        const exporter = buildExporter();
        const opaque = new Error('Cannot convert circular structure to BSON');

        const telemetryInsertMany = vi.fn(async () => {
            throw opaque;
        });
        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: { insertMany: telemetryInsertMany },
        };

        (exporter as any).normalTelemetryBuffer = [
            buildTelemetryItem('a', { _id: 'oid-1' }),
            buildTelemetryItem('b', { _id: 'oid-2' }),
        ];

        await (exporter as any).flushTelemetry();

        const bufferAfter = (exporter as any).normalTelemetryBuffer as any[];
        expect(bufferAfter).toHaveLength(2);
        for (const item of bufferAfter) {
            expect(item._id).toBeUndefined();
        }
    });
});

/**
 * Coverage for the audit follow-ups (P0 #1..#5 from the issue #1106
 * deep-dive). Each test pins one of the production-grade failure modes
 * that the issue did NOT mention but the audit surfaced.
 */
describe('MongoDBExporter — P0 audit follow-ups', () => {
    /** Build an exporter whose WAL + DLQ paths point at a per-test temp
     * dir, so we can assert on the on-disk artefacts without colliding
     * with real worker state. */
    function buildExporterWithTempFs() {
        const dir = `${tmpdir()}/kodus-exporter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const walPath = join(dir, 'wal.jsonl');
        const dlqPath = join(dir, 'dlq.jsonl');
        const exporter = buildExporter();
        (exporter as any).walPath = walPath;
        (exporter as any).walProcessingPath = walPath + '.processing';
        (exporter as any).dlqPath = dlqPath;
        return { exporter, dir, walPath, dlqPath };
    }

    afterEach(async () => {
        // Clean up any /tmp/kodus-exporter-test-* dirs we may have left.
        try {
            const entries = await fs.readdir(tmpdir());
            await Promise.all(
                entries
                    .filter((e) => e.startsWith('kodus-exporter-test-'))
                    .map((e) =>
                        fs.rm(join(tmpdir(), e), {
                            recursive: true,
                            force: true,
                        }),
                    ),
            );
        } catch {
            // best-effort cleanup
        }
    });

    // ── P0 #5 — try/finally guarantees flag release ──────────────────
    it('P0 #5: isFlushingTelemetry is released even if code outside the inner try throws', async () => {
        const exporter = buildExporter();
        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: { insertMany: vi.fn() },
        };

        // Inject a buffer with one item and make `screenForBson` throw
        // — it lives between `isFlushingTelemetry = true` and the inner
        // try blocks. Pre-fix this would have left the flag pinned at
        // `true`, silently stopping every future flush.
        (exporter as any).normalTelemetryBuffer = [
            { traceId: 't', spanId: 's', name: 'n' } as any,
        ];
        (exporter as any).screenForBson = () => {
            throw new Error('synthetic mid-flush failure');
        };

        await expect((exporter as any).flushTelemetry()).rejects.toThrow(
            'synthetic mid-flush failure',
        );

        // The flag MUST be back to false despite the throw.
        expect((exporter as any).isFlushingTelemetry).toBe(false);
    });

    // ── P0 #3 — recoverFromWal is idempotent within one process ──────
    it('P0 #3: recoverFromWal runs once per process; subsequent reconnects skip', async () => {
        const { exporter, walPath } = buildExporterWithTempFs();
        await fs.mkdir(walPath.substring(0, walPath.lastIndexOf('/')), {
            recursive: true,
        });
        await fs.writeFile(
            walPath,
            JSON.stringify({ traceId: 't', spanId: 's' } as any) + '\n',
        );

        // First recovery: drains the file.
        await (exporter as any).recoverFromWal();
        expect((exporter as any).criticalTelemetryBuffer).toHaveLength(1);
        expect((exporter as any).walRecovered).toBe(true);

        // Re-write the WAL to simulate spans piling up during the
        // reconnect window. Without P0 #3 the next recoverFromWal
        // would re-replay the file and double the buffer.
        await fs.writeFile(
            walPath,
            JSON.stringify({ traceId: 'X', spanId: 'Y' } as any) + '\n',
        );
        (exporter as any).criticalTelemetryBuffer = []; // simulate flush
        await (exporter as any).recoverFromWal();

        // No replay → buffer stays empty (no double-recovery).
        expect((exporter as any).criticalTelemetryBuffer).toHaveLength(0);
    });

    // ── P0 #4 — critical respects the open circuit ───────────────────
    it('P0 #4: critical flush does NOT call insertMany when circuit is open', async () => {
        const exporter = buildExporter();
        const telemetryInsertMany = vi.fn();
        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: { insertMany: telemetryInsertMany },
        };
        // Force circuit open.
        (exporter as any).circuitBreakerState = 'open';
        (exporter as any).lastFailureTime = Date.now();

        (exporter as any).criticalTelemetryBuffer = [
            { traceId: 't', spanId: 's', name: 'n' } as any,
        ];

        await (exporter as any).flushTelemetry();

        // Pre-fix: insertMany would have been called, failed (real
        // Mongo down), logged "🚨 CRITICAL: Failed to flush LLM
        // spans", and that pattern dominated the error feed during
        // outages. Post-fix: insertMany is skipped, buffer is kept,
        // WAL keeps the on-disk persistence.
        expect(telemetryInsertMany).not.toHaveBeenCalled();
        expect((exporter as any).criticalTelemetryBuffer).toHaveLength(1);
    });

    // ── P0 #1 — atomic WAL hand-off (rename → unlink) ────────────────
    it('P0 #1: writeToWal during a successful flush lands in a fresh walPath, not the unlinked file', async () => {
        const { exporter, walPath } = buildExporterWithTempFs();
        await fs.mkdir(walPath.substring(0, walPath.lastIndexOf('/')), {
            recursive: true,
        });

        // Seed the live WAL with one span (simulating spans written
        // before the flush started).
        await fs.writeFile(
            walPath,
            JSON.stringify({ traceId: 't0', spanId: 's0' }) + '\n',
        );

        // Mock insertMany so we control the timing.
        let writeDuringFlightResult = '';
        const telemetryInsertMany = vi.fn(async () => {
            // Mid-flight: another part of the system records a span.
            // With P0 #1 this lands on a fresh walPath; without it,
            // the line is appended to a file that's about to be
            // unlinked.
            await (exporter as any).writeToWal({
                traceId: 't1',
                spanId: 's1',
            } as any);
            // Read the live WAL to observe what's there mid-flush.
            writeDuringFlightResult = await fs
                .readFile(walPath, 'utf8')
                .catch(() => '');
            return {
                acknowledged: true,
                insertedCount: 1,
                insertedIds: { 0: 'fresh' },
            };
        });
        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: { insertMany: telemetryInsertMany },
        };

        (exporter as any).criticalTelemetryBuffer = [
            { traceId: 't0', spanId: 's0', name: 'n' } as any,
        ];

        await (exporter as any).flushTelemetry();

        // The mid-flight writeToWal must have landed in the live
        // walPath, NOT in the renamed walProcessingPath.
        expect(writeDuringFlightResult).toContain('t1');
        // After success, walProcessingPath is gone but walPath remains
        // with the span written during the flight.
        const liveAfter = await fs.readFile(walPath, 'utf8').catch(() => '');
        expect(liveAfter).toContain('t1');
        expect(liveAfter).not.toContain('t0'); // t0 already flushed
    });

    it('P0 #1: insertMany failure merges in-flight WAL back into live so recovery sees it', async () => {
        const { exporter, walPath } = buildExporterWithTempFs();
        await fs.mkdir(walPath.substring(0, walPath.lastIndexOf('/')), {
            recursive: true,
        });
        const seed = JSON.stringify({ traceId: 't0', spanId: 's0' }) + '\n';
        await fs.writeFile(walPath, seed);

        const bulkErr: any = new Error('partial commit');
        bulkErr.name = 'MongoBulkWriteError';
        bulkErr.result = { insertedIds: {} };
        bulkErr.writeErrors = [{ index: 0, code: 121, errmsg: 'rejected' }];

        (exporter as any).collections = {
            logs: { insertMany: vi.fn() },
            telemetry: {
                insertMany: vi.fn(async () => {
                    throw bulkErr;
                }),
            },
        };

        (exporter as any).criticalTelemetryBuffer = [
            { traceId: 't0', spanId: 's0', name: 'n', _id: 'oid' } as any,
        ];

        await (exporter as any).flushTelemetry();

        // Failure path → walProcessingPath has been merged back into
        // walPath; the orphaned processing file is gone.
        const liveAfter = await fs.readFile(walPath, 'utf8').catch(() => '');
        expect(liveAfter).toContain('t0');
        const processingExists = await fs
            .stat((exporter as any).walProcessingPath)
            .then(() => true)
            .catch(() => false);
        expect(processingExists).toBe(false);
    });

    // ── P0 #2 — size-bounded WAL/DLQ ─────────────────────────────────
    it('P0 #2: WAL rotation trims the oldest half when the file exceeds the size cap', async () => {
        const { exporter, walPath } = buildExporterWithTempFs();
        await fs.mkdir(walPath.substring(0, walPath.lastIndexOf('/')), {
            recursive: true,
        });
        // Cap is the default 100MB — too big for a unit test. Shrink it.
        (exporter as any).walMaxBytes = 1024; // 1KB

        // Write ~3KB of synthetic spans (3x the cap).
        const line = JSON.stringify({
            traceId: 'x'.repeat(100),
            spanId: 'y',
        });
        await fs.writeFile(walPath, (line + '\n').repeat(30));
        const before = (await fs.stat(walPath)).size;
        expect(before).toBeGreaterThan(1024);

        // Trigger rotation by calling writeToWal once.
        await (exporter as any).writeToWal({
            traceId: 'new',
            spanId: 'new',
        });

        const after = (await fs.stat(walPath)).size;
        // After: the oldest half is gone and one fresh line was appended.
        expect(after).toBeLessThan(before);
    });

    it('P0 #2: DLQ rotates to .1 when it exceeds the size cap', async () => {
        const { exporter, dlqPath } = buildExporterWithTempFs();
        await fs.mkdir(dlqPath.substring(0, dlqPath.lastIndexOf('/')), {
            recursive: true,
        });
        (exporter as any).dlqMaxBytes = 256;

        const oldLine = JSON.stringify({ old: 'x'.repeat(200) }) + '\n';
        await fs.writeFile(dlqPath, oldLine.repeat(5));
        expect((await fs.stat(dlqPath)).size).toBeGreaterThan(256);

        await (exporter as any).writeToDeadLetterQueue([
            { traceId: 'new', spanId: 'new' } as any,
        ]);

        // Rotation moved the oversized file aside; new file is a fresh
        // small one containing only the just-written item.
        const rotatedExists = await fs
            .stat(`${dlqPath}.1`)
            .then(() => true)
            .catch(() => false);
        expect(rotatedExists).toBe(true);

        const liveAfter = await fs.readFile(dlqPath, 'utf8');
        expect(liveAfter).toContain('"traceId":"new"');
        expect(liveAfter).not.toContain('"old":"xxx');
    });
});
