import { createHash } from 'crypto';

import type { Pool, PoolClient } from 'pg';

/**
 * Every Postgres advisory lock the Runtime takes, by namespace. A key is
 * shared state between processes and releases: two code paths exclude each
 * other only if they build the key the same way, and a release running beside
 * the previous one during a deploy must build the keys the previous one did.
 * So a namespace's key scheme never changes once shipped
 * (advisory-lock.spec.ts and advisory-lock.integration.spec.ts pin them),
 * and a new lock adds a namespace here instead of hashing its own key.
 *
 * Key spaces: a single bigint key (objsubid 1 in pg_locks) never collides with
 * a pair of int4 keys (objsubid 2), whatever their values.
 */
export type LockNamespace =
    /** Runtime schema migrations (session lock, the only constant key). */
    | 'migration'
    /** PgDistributedLocks: a named cluster-wide section (session lock). */
    | 'named'
    /** Commit order of one Run's stream appends. */
    | 'run_stream'
    /** The admission quota of every org (one global key). */
    | 'admission_quota'
    /** An org's capped cell reservations (cell directory and physical admission take the same key). */
    | 'cell_reservation'
    /** An org's machine minutes of one UTC day. */
    | 'machine_minutes_org_day'
    /** External findings admission and maintenance of one org (product Postgres). */
    | 'external_findings_org';

interface LockParts {
    migration: [];
    named: [name: string];
    run_stream: [orgId: string, runId: string];
    admission_quota: [];
    cell_reservation: [orgId: string];
    machine_minutes_org_day: [orgId: string, day: string];
    external_findings_org: [orgId: string];
}

/**
 * The key of one advisory lock: how Postgres reads it (`form`) and the values
 * bound to it. `int8` is one bigint, `int4_pair` two int4, `hashtext` and
 * `hashtextextended` one key Postgres hashes from the text, `class_hashtext`
 * an int4 class plus the int4 hash of the text.
 */
export type LockKey =
    | { form: 'int8'; values: [number] }
    | { form: 'int4_pair'; values: [number, number] }
    | { form: 'hashtext'; values: [string] }
    | { form: 'hashtextextended'; values: [string] }
    | { form: 'class_hashtext'; values: [number, string] };

const MIGRATION_LOCK = 727001;
const MACHINE_MINUTES_CLASS = 727002;

/** Two int4 keys from the first 8 bytes of a sha256. */
function sha256Pair(text: string): [number, number] {
    const h = createHash('sha256').update(text).digest();
    return [h.readInt32BE(0), h.readInt32BE(4)];
}

/** The key of a lock in `namespace` for `parts` (an org, a Run, a name). */
export function lockKey<N extends LockNamespace>(namespace: N, ...parts: LockParts[N]): LockKey {
    const p = parts as string[];
    switch (namespace) {
        case 'migration':
            return { form: 'int8', values: [MIGRATION_LOCK] };
        case 'named':
            return { form: 'int4_pair', values: sha256Pair(`kody-runtime/lock\0${p[0]}`) };
        case 'run_stream':
            return { form: 'int4_pair', values: sha256Pair(`kody-runtime/run-stream\0${p[0]}\0${p[1]}`) };
        case 'admission_quota':
            return { form: 'int4_pair', values: sha256Pair('kody-runtime/admission-quota') };
        case 'cell_reservation':
            return { form: 'hashtext', values: [`runtime.cell_reservation:${p[0]}`] };
        case 'machine_minutes_org_day':
            return { form: 'class_hashtext', values: [MACHINE_MINUTES_CLASS, `${p[0]}/${p[1]}`] };
        case 'external_findings_org':
            // Shipped without a prefix: the bare org id, in the product Postgres.
            return { form: 'hashtextextended', values: [p[0]] };
        default:
            throw new Error(`unknown advisory lock namespace: ${String(namespace)}`);
    }
}

export type AdvisoryLockFn = 'pg_advisory_lock' | 'pg_try_advisory_lock' | 'pg_advisory_unlock' | 'pg_advisory_xact_lock' | 'pg_try_advisory_xact_lock';

/** The call `fn(<key>)` with the key bound from `$first` on, to put inside a larger statement. */
export function lockCall(fn: AdvisoryLockFn, key: LockKey, first = 1): { sql: string; values: unknown[] } {
    const a = `$${first}`;
    const b = `$${first + 1}`;
    const args = {
        int8: `${a}::bigint`,
        int4_pair: `${a}::int, ${b}::int`,
        hashtext: `hashtext(${a})`,
        hashtextextended: `hashtextextended(${a}, 0)`,
        class_hashtext: `${a}::int, hashtext(${b})`,
    }[key.form];
    return { sql: `${fn}(${args})`, values: [...key.values] };
}

/** `SELECT fn(<key>) AS acquired`: `acquired` is the boolean of a try, null for a wait. */
export function lockStatement(fn: AdvisoryLockFn, key: LockKey): { text: string; values: unknown[] } {
    const call = lockCall(fn, key);
    return { text: `SELECT ${call.sql} AS acquired`, values: call.values };
}

/**
 * Runs `fn` between BEGIN and COMMIT on a connection already held; ROLLBACK (and the error) when it throws.
 * A failed ROLLBACK does not replace the work's error; `onRollbackFailed` tells the holder the connection
 * may still be inside the transaction.
 */
export async function inTransaction<T>(
    client: Pick<PoolClient, 'query'>,
    fn: () => Promise<T>,
    opts: { readOnly?: boolean; onRollbackFailed?: () => void } = {},
): Promise<T> {
    await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    try {
        const out = await fn();
        await client.query('COMMIT');
        return out;
    } catch (e) {
        // The work's error wins; the holder learns of the failed ROLLBACK through onRollbackFailed.
        await client.query('ROLLBACK').catch(() => opts.onRollbackFailed?.());
        throw e;
    }
}

/** Runs `fn` in one transaction on a connection of the pool, held for the transaction and released after. */
export async function withTransaction<T>(pool: Pick<Pool, 'connect'>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
        return await inTransaction(client, () => fn(client), { onRollbackFailed: () => (broken = true) });
    } finally {
        // A connection whose ROLLBACK failed may still be in the transaction: it is destroyed, never pooled.
        client.release(broken || undefined);
    }
}
