import { createHash } from 'crypto';

import { InvalidStreamOffsetError, type RunStreamEvent, type RunStreamPage, type RunStreamStore, streamKeyOf } from '../run-stream';

// The Run stream in the Runtime Postgres (RUNTIME_STREAM_STORE=postgres, the
// default): one ordered log per Run (runtime.runtime_run_events) that every
// hub replica appends to and any reader reads by offset, without a shared
// volume. The hub writes it with the Runtime role; the API reads it with the
// read-only one (RUNTIME_DATABASE_READ_URL). A keyed event is written once
// (a retried step or worker post is a no-op); each event is bounded in size;
// rows go after 30 days (applyRetention).

export interface KeyedRunStreamStore extends RunStreamStore {
    append(orgId: string, runId: string, event: RunStreamEvent, key?: string): Promise<void>;
}

/** The SQL this store needs: a pg Pool, or a read-only transaction around one. */
export interface SqlRunner {
    query(text: string, values: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** One event's JSON at most (a step or run event is a few hundred bytes; a runaway payload is refused). */
export const RUN_STREAM_EVENT_MAX_BYTES = 64 * 1_024;

export class RunStreamEventTooLargeError extends Error {}

const encode = (seq: number) => Buffer.from(`s${seq}`).toString('base64url');

/** The seq an opaque Postgres offset names (0 for the start); anything else is refused. */
export function decodePgStreamOffset(offset?: string): number {
    if (!offset || offset === '-1') return 0;
    const m = /^s(\d{1,18})$/.exec(Buffer.from(offset, 'base64url').toString());
    if (!m) throw new InvalidStreamOffsetError('invalid offset');
    return Number(m[1]);
}

export class PgRunStreamStore implements KeyedRunStreamStore {
    constructor(private readonly db: SqlRunner) {}

    async append(orgId: string, runId: string, event: RunStreamEvent, key?: string): Promise<void> {
        streamKeyOf(orgId, runId);
        const json = JSON.stringify(event);
        if (Buffer.byteLength(json) > RUN_STREAM_EVENT_MAX_BYTES) throw new RunStreamEventTooLargeError(`a stream event is larger than ${RUN_STREAM_EVENT_MAX_BYTES} bytes`);
        // Per-stream commit order must precede nextval: a reader may resume past any visible seq (#2460).
        // Two int4 keys use a separate advisory-lock space from the single-bigint locks.
        const lock = createHash('sha256').update(`kody-runtime/run-stream\0${orgId}\0${runId}`).digest();
        await this.db.query(
            `WITH stream_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock($5::int, $6::int))
             INSERT INTO runtime.runtime_run_events (org_id, run_id, event_key, event)
             SELECT $1, $2, $3, $4 FROM stream_lock WHERE true
             ON CONFLICT (run_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
            [orgId, runId, key ?? null, json, lock.readInt32BE(0), lock.readInt32BE(4)],
        );
    }

    async read(orgId: string, runId: string, offset?: string, maxEvents = 500): Promise<RunStreamPage | null> {
        const after = decodePgStreamOffset(offset);
        const limit = Math.min(Math.max(1, Math.floor(maxEvents)), 1_000);
        // runtime_run_events_run_idx (org_id, run_id, seq): an index range scan, never the table.
        const r = await this.db.query(
            `SELECT seq, event FROM runtime.runtime_run_events WHERE org_id = $1 AND run_id = $2 AND seq > $3 ORDER BY seq LIMIT $4`,
            [orgId, runId, after, limit + 1],
        );
        if (!r.rows.length && after === 0) return null;
        const rows = r.rows.slice(0, limit);
        const last = rows.length ? Number(rows[rows.length - 1].seq) : after;
        return { events: rows.map((x) => x.event as RunStreamEvent), nextOffset: encode(last), upToDate: r.rows.length <= limit };
    }
}
