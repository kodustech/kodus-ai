import { InvalidStreamOffsetError, type RunStreamEvent } from '../run-stream';
import { PgRunStreamStore, RUN_STREAM_EVENT_MAX_BYTES, RunStreamEventTooLargeError, type SqlRunner } from './pg-run-stream.store';

// The SQL is exercised against a real Postgres in apps/runtime/src/hub/pg-hub-store.integration.spec.ts;
// here, what the store sends and what it refuses.

const event = (data: Record<string, unknown> = {}): RunStreamEvent => ({ type: 'phase', at: '2026-11-07T00:00:00.000Z', data });

function recorder(rows: Array<{ seq: number; event: RunStreamEvent }> = []) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db: SqlRunner = {
        async query(text, values) {
            calls.push({ text, values });
            return { rows };
        },
    };
    return { db, calls };
}

describe('PgRunStreamStore', () => {
    it('takes a transaction lock for the exact org and Run before the insert allocates a sequence', async () => {
        const { db, calls } = recorder();
        const s = new PgRunStreamStore(db);
        await s.append('org-1', 'run-1', event());
        await s.append('org-1', 'run-1', event(), 'repeat');
        await s.append('org-2', 'run-1', event());
        await s.append('org-1', 'run-2', event());
        expect(calls[0].text).toMatch(/WITH stream_lock AS MATERIALIZED\s*\(\s*SELECT pg_advisory_xact_lock\(\$5::int, \$6::int\)/);
        expect(calls[0].text).toMatch(/SELECT \$1, \$2, \$3, \$4 FROM stream_lock/);
        expect(calls[0].values.slice(4)).toHaveLength(2);
        expect(calls[0].values.slice(4)).toEqual(calls[1].values.slice(4));
        expect(calls[0].values.slice(4)).not.toEqual(calls[2].values.slice(4));
        expect(calls[0].values.slice(4)).not.toEqual(calls[3].values.slice(4));
        expect(calls[0].values.slice(4).every((v) => Number.isInteger(v) && Number(v) >= -2_147_483_648 && Number(v) <= 2_147_483_647)).toBe(true);
    });

    it('writes a keyed event once (ON CONFLICT on the Run and key) and an unkeyed one as is', async () => {
        const { db, calls } = recorder();
        const s = new PgRunStreamStore(db);
        await s.append('org-1', 'run-1', event(), 'step:abc:started');
        await s.append('org-1', 'run-1', event());
        expect(calls[0].text).toMatch(/ON CONFLICT \(run_id, event_key\) WHERE event_key IS NOT NULL DO NOTHING/);
        expect(calls[0].values.slice(0, 3)).toEqual(['org-1', 'run-1', 'step:abc:started']);
        expect(calls[1].values[2]).toBeNull();
    });

    it('refuses an event past its size bound and a stream key that is not an id', async () => {
        const { db, calls } = recorder();
        const s = new PgRunStreamStore(db);
        await expect(s.append('org-1', 'run-1', event({ blob: 'x'.repeat(RUN_STREAM_EVENT_MAX_BYTES) }))).rejects.toBeInstanceOf(RunStreamEventTooLargeError);
        await expect(s.append('org/1', 'run-1', event())).rejects.toThrow('invalid stream key');
        expect(calls).toEqual([]);
    });

    it('reads by org and Run after the offset, at most 1000 a page', async () => {
        const { db, calls } = recorder([{ seq: 7, event: event({ n: 1 }) }]);
        const page = await new PgRunStreamStore(db).read('org-1', 'run-1', undefined, 50_000);
        expect(calls[0].text).toMatch(/WHERE org_id = \$1 AND run_id = \$2 AND seq > \$3 ORDER BY seq LIMIT \$4/);
        expect(calls[0].values).toEqual(['org-1', 'run-1', 0, 1_001]);
        expect(page).toMatchObject({ events: [event({ n: 1 })], upToDate: true });
        await expect(new PgRunStreamStore(db).read('org-1', 'run-1', 'forged')).rejects.toBeInstanceOf(InvalidStreamOffsetError);
    });
});
