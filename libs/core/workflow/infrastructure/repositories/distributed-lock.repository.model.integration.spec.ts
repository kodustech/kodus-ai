/**
 * INTEGRATION TEST — the lease SQL against a reference model.
 *
 * Thousands of random operations (acquire, renew, release, isHeld, time
 * passing the lease or the max hold, sweep) over a few keys and holders run
 * against a real Postgres, and the same Postgres behind PgBouncer in
 * transaction mode. After every step the database's answer must equal what
 * a plain in-memory lock would answer. A seeded generator makes any failure
 * reproducible: the failing seed and step are in the message.
 *
 * Time is moved on the database clock (UPDATE ... now() - 1s), never slept.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';

import { DistributedLockLeases2026112300000000 } from '@libs/core/infrastructure/database/typeorm/migrations/2026112300000000-DistributedLockLeases';

import { DistributedLockRepository } from './distributed-lock.repository';

const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = parseInt(
    process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
    10,
);
const PGBOUNCER_PORT = process.env.TEST_PGBOUNCER_PORT
    ? parseInt(process.env.TEST_PGBOUNCER_PORT, 10)
    : undefined;
const PG_USER =
    process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const PG_PASSWORD =
    process.env.TEST_PG_PASSWORD ??
    process.env.API_PG_DB_PASSWORD ??
    'kodusdev';
const PG_DB =
    process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db';
const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

if (!skipIntegration && process.env.CI && PGBOUNCER_PORT === undefined) {
    throw new Error(
        'TEST_PGBOUNCER_PORT is required in CI: the PgBouncer case is what this spec exists for.',
    );
}

const TABLE = '"kodus_workflow"."distributed_locks"';
const SEEDS = [1, 2, 3, 42, 1337];
const STEPS = 400;

/** mulberry32: small, seedable, good enough to explore operation orders. */
function prng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** What a lock with leases and an optional max hold should answer. */
class ModelLock {
    rows = new Map<
        string,
        {
            holder: string;
            expired: boolean;
            hasMaxHold: boolean;
            pastMaxHold: boolean;
        }
    >();

    tryAcquire(key: string, holder: string, maxHold: boolean): boolean {
        const row = this.rows.get(key);
        if (row && !row.expired) return false;
        this.rows.set(key, {
            holder,
            expired: false,
            hasMaxHold: maxHold,
            pastMaxHold: false,
        });
        return true;
    }

    renew(key: string, holder: string): boolean {
        const row = this.rows.get(key);
        if (!row || row.holder !== holder) return false;
        // A renewal that lands after the lease ran out, before anyone took
        // the key, keeps it; past the max hold it stays expired.
        row.expired = row.pastMaxHold;
        return !row.expired;
    }

    release(key: string, holder: string): boolean {
        const row = this.rows.get(key);
        if (!row || row.holder !== holder) return false;
        this.rows.delete(key);
        return true;
    }

    isHeld(key: string): boolean {
        const row = this.rows.get(key);
        return !!row && !row.expired;
    }

    leasePasses(key: string): void {
        const row = this.rows.get(key);
        if (row) row.expired = true;
    }

    maxHoldPasses(key: string): void {
        const row = this.rows.get(key);
        if (row && row.hasMaxHold) {
            row.pastMaxHold = true;
            row.expired = true;
        }
    }

    sweep(): number {
        let n = 0;
        for (const [key, row] of this.rows) {
            if (row.expired) {
                this.rows.delete(key);
                n++;
            }
        }
        return n;
    }
}

const targets = [
    { name: 'Postgres, direct', port: PG_PORT },
    ...(PGBOUNCER_PORT !== undefined
        ? [{ name: 'PgBouncer, transaction mode', port: PGBOUNCER_PORT }]
        : []),
];

(skipIntegration ? describe.skip : describe)(
    'DistributedLockRepository against a reference model (integration)',
    () => {
        beforeAll(async () => {
            const direct = new DataSource({
                type: 'postgres',
                host: PG_HOST,
                port: PG_PORT,
                username: PG_USER,
                password: PG_PASSWORD,
                database: PG_DB,
                entities: [],
            });
            await direct.initialize();
            const runner = direct.createQueryRunner();
            await new DistributedLockLeases2026112300000000().up(runner);
            await runner.release();
            await direct.destroy();
        }, 30_000);

        describe.each(targets)('on $name', ({ port }) => {
            let ds: DataSource;
            let repository: DistributedLockRepository;

            beforeAll(async () => {
                ds = new DataSource({
                    type: 'postgres',
                    host: PG_HOST,
                    port,
                    username: PG_USER,
                    password: PG_PASSWORD,
                    database: PG_DB,
                    entities: [],
                    extra: { max: 2 },
                });
                await ds.initialize();
                repository = new DistributedLockRepository(ds);
            });

            afterAll(async () => {
                await ds.destroy();
            });

            it.each(SEEDS)(
                'answers like the model for %i-seeded random operations',
                async (seed) => {
                    const run = `model::${port}::${seed}::${Date.now()}`;
                    const keys = ['a', 'b', 'c'].map((k) => `${run}::${k}`);
                    const holders = ['h1', 'h2', 'h3'];
                    const model = new ModelLock();
                    const rand = prng(seed);
                    const pick = <T>(xs: T[]) =>
                        xs[Math.floor(rand() * xs.length)];
                    const trace: string[] = [];

                    for (let step = 0; step < STEPS; step++) {
                        const key = pick(keys);
                        const holder = pick(holders);
                        const roll = rand();
                        let op: string;
                        let actual: unknown;
                        let expected: unknown;

                        if (roll < 0.3) {
                            const maxHold = rand() < 0.5;
                            op = `tryAcquire(${key}, ${holder}, maxHold=${maxHold})`;
                            actual = await repository.tryAcquire(
                                key,
                                holder,
                                60_000,
                                maxHold ? 120_000 : undefined,
                            );
                            expected = model.tryAcquire(key, holder, maxHold);
                        } else if (roll < 0.45) {
                            op = `renew(${key}, ${holder})`;
                            actual = await repository.renew(
                                key,
                                holder,
                                60_000,
                            );
                            expected = model.renew(key, holder);
                        } else if (roll < 0.6) {
                            op = `release(${key}, ${holder})`;
                            actual = await repository.release(key, holder);
                            expected = model.release(key, holder);
                        } else if (roll < 0.75) {
                            op = `isHeld(${key})`;
                            actual = await repository.isHeld(key);
                            expected = model.isHeld(key);
                        } else if (roll < 0.87) {
                            op = `leasePasses(${key})`;
                            await ds.query(
                                `UPDATE ${TABLE} SET expires_at = now() - interval '1 second' WHERE lock_key = $1`,
                                [key],
                            );
                            model.leasePasses(key);
                            actual = expected = undefined;
                        } else if (roll < 0.95) {
                            op = `maxHoldPasses(${key})`;
                            // Time past the max hold is also past any lease
                            // capped by it.
                            await ds.query(
                                `UPDATE ${TABLE}
                                    SET max_hold_until = now() - interval '1 second',
                                        expires_at = LEAST(expires_at, now() - interval '1 second')
                                  WHERE lock_key = $1 AND max_hold_until IS NOT NULL`,
                                [key],
                            );
                            model.maxHoldPasses(key);
                            actual = expected = undefined;
                        } else {
                            op = 'sweep()';
                            // Other specs share the table and sweep it too.
                            // Age only this run's expired rows past the sweep
                            // grace, and judge the sweep by this run's keys.
                            await ds.query(
                                `UPDATE ${TABLE} SET expires_at = now() - interval '2 hours'
                                  WHERE lock_key = ANY($1) AND expires_at <= now()`,
                                [keys],
                            );
                            const ours = async () =>
                                Number(
                                    (
                                        await ds.query(
                                            `SELECT count(*)::int AS n FROM ${TABLE} WHERE lock_key = ANY($1)`,
                                            [keys],
                                        )
                                    )[0].n,
                                );
                            const before = await ours();
                            const deleted = await repository.deleteExpired(
                                60 * 60 * 1000,
                            );
                            const removed = before - (await ours());
                            if (deleted < removed) {
                                throw new Error(
                                    `seed ${seed}, step ${step}: sweep reported ${deleted} but removed ${removed} of this run's rows`,
                                );
                            }
                            actual = removed;
                            expected = model.sweep();
                        }

                        trace.push(`${step}: ${op} -> ${String(actual)}`);
                        if (actual !== expected) {
                            throw new Error(
                                `seed ${seed}, step ${step}: ${op} returned ${String(actual)}, model says ${String(expected)}\n` +
                                    trace.slice(-15).join('\n'),
                            );
                        }
                        // The whole visible state must agree, not only the
                        // value this operation returned.
                        for (const k of keys) {
                            const held = await repository.isHeld(k);
                            if (held !== model.isHeld(k)) {
                                throw new Error(
                                    `seed ${seed}, after step ${step} (${op}): isHeld(${k}) is ${held}, model says ${model.isHeld(k)}\n` +
                                        trace.slice(-15).join('\n'),
                                );
                            }
                        }
                    }
                    await ds.query(
                        `DELETE FROM ${TABLE} WHERE lock_key LIKE $1`,
                        [`${run}::%`],
                    );
                },
                120_000,
            );
        });
    },
);
