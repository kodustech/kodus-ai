import { randomUUID } from 'crypto';

import { Pool, type PoolClient } from 'pg';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';

import type { RunStreamEvent } from '../run-stream';
import { decodePgStreamOffset, PgRunStreamStore } from './pg-run-stream.store';

const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const event = (label: string): RunStreamEvent => ({ type: 'phase', at: '2026-11-07T00:00:00.000Z', data: { label } });

(skip ? describe.skip : describe)('Postgres Run stream commit ordering (real Postgres)', () => {
    let pool: Pool;
    const streams: Array<[string, string]> = [];
    const stream = (org = `org-${randomUUID()}`, run = `run-${randomUUID()}`) => {
        streams.push([org, run]);
        return { org, run };
    };

    beforeAll(async () => {
        pool = new Pool({ connectionString: url, max: 6 });
        await ensureRuntimeSchema(pool);
    });

    afterAll(async () => {
        if (!pool) return;
        try {
            await pool.query('DELETE FROM runtime.runtime_run_events WHERE (org_id, run_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))', [streams.map(([org]) => org), streams.map(([, run]) => run)]);
        } finally {
            await pool.end();
        }
    });

    /** Observe the submitted insert, not the client's preceding idle PID query. */
    async function waitForInsert(pid: number) {
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
            const row = (await pool.query(
                `SELECT state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
                 WHERE pid = $1 AND query LIKE '%INSERT INTO runtime.runtime_run_events%'`, [pid],
            )).rows[0];
            if (row && (row.state === 'idle' || row.wait_event_type === 'Lock')) return row;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('the submitted stream insert neither committed nor reached a database lock');
    }

    async function clients(fn: (a: PoolClient, b: PoolClient) => Promise<void>) {
        const a = await pool.connect();
        const b = await pool.connect();
        try {
            await fn(a, b);
        } finally {
            await a.query('ROLLBACK');
            await b.query('ROLLBACK');
            a.release();
            b.release();
        }
    }

    it('does not allocate a later sequence or advance a cursor while an earlier same-Run append is uncommitted', async () => clients(async (a, b) => {
        const { org, run } = stream();
        const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const first = new PgRunStreamStore(a);
        const second = new PgRunStreamStore(b);
        const reader = new PgRunStreamStore(pool);
        await a.query('BEGIN');
        await first.append(org, run, event('first'), 'first');
        const sequence = (await pool.query('SELECT last_value::text AS value FROM runtime.runtime_run_events_seq_seq')).rows[0].value;
        const pending = second.append(org, run, event('second'), 'second');
        try {
            const state = await waitForInsert(bPid);
            const beforeCommit = await reader.read(org, run);
            expect(beforeCommit).toBeNull();
            expect(state).toMatchObject({ state: 'active', wait_event_type: 'Lock', wait_event: 'advisory', blockers: [aPid] });
            expect((await pool.query('SELECT last_value::text AS value FROM runtime.runtime_run_events_seq_seq')).rows[0].value).toBe(sequence);
            await a.query('COMMIT');
            await pending;
            const firstPage = (await reader.read(org, run, undefined, 1))!;
            expect(firstPage.events).toEqual([event('first')]);
            expect(firstPage.upToDate).toBe(false);
            const next = (await reader.read(org, run, firstPage.nextOffset, 1))!;
            expect(next.events).toEqual([event('second')]);
            expect(next.upToDate).toBe(true);
            expect(decodePgStreamOffset(next.nextOffset)).toBeGreaterThan(decodePgStreamOffset(firstPage.nextOffset));
            expect((await reader.read(org, run, next.nextOffset))!.events).toEqual([]);
        } finally {
            await a.query('ROLLBACK');
            await pending.catch(() => undefined);
        }
    }));

    it('keeps another Run and another org independent of an uncommitted append', async () => clients(async (a, b) => {
        const held = stream();
        const anotherRun = stream(held.org);
        const anotherOrg = stream(undefined, held.run);
        await a.query('BEGIN');
        await new PgRunStreamStore(a).append(held.org, held.run, event('held'), 'held');
        await b.query("SET statement_timeout = '2s'");
        try {
            const other = new PgRunStreamStore(b);
            await other.append(anotherRun.org, anotherRun.run, event('another-run'), 'another-run');
            await other.append(anotherOrg.org, anotherOrg.run, event('another-org'), 'another-org');
            expect((await other.read(anotherRun.org, anotherRun.run))!.events).toEqual([event('another-run')]);
            expect((await other.read(anotherOrg.org, anotherOrg.run))!.events).toEqual([event('another-org')]);
            expect(await other.read(held.org, held.run)).toBeNull();
        } finally {
            await b.query('RESET statement_timeout');
        }
    }));

    it('releases the transaction lock on rollback and never exposes the rolled-back event', async () => clients(async (a, b) => {
        const { org, run } = stream();
        const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await a.query('BEGIN');
        await new PgRunStreamStore(a).append(org, run, event('rolled-back'), 'rolled-back');
        const pending = new PgRunStreamStore(b).append(org, run, event('committed'), 'committed');
        try {
            await waitForInsert(bPid);
            await a.query('ROLLBACK');
            await pending;
            expect((await new PgRunStreamStore(pool).read(org, run))!.events).toEqual([event('committed')]);
        } finally {
            await a.query('ROLLBACK');
            await pending.catch(() => undefined);
        }
    }));

    it('keeps concurrent keyed retries idempotent', async () => {
        const { org, run } = stream();
        const store = new PgRunStreamStore(pool);
        await Promise.all(Array.from({ length: 6 }, () => store.append(org, run, event('same'), 'same-key')));
        expect((await store.read(org, run))!.events).toEqual([event('same')]);
        await store.append(org, run, event('next'), 'next-key');
        const first = (await store.read(org, run, undefined, 1))!;
        expect((await store.read(org, run, first.nextOffset))!.events).toEqual([event('next')]);
    });
});
