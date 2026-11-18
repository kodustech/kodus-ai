import { Pool } from 'pg';

import { lockKey, lockStatement, withTransaction, type LockKey } from './advisory-lock';

// The lock Postgres actually holds (pg_locks) for each namespace, pinned to the
// values the shipped SQL took before the keys moved here, e.g. the cell
// reservation's hashtext('runtime.cell_reservation:' || $1). Opt-in:
// RUNTIME_IT_DATABASE_URL (locally postgres://runtime:runtime@localhost:5442/kodus_runtime_it).
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const SHIPPED: Array<[string, LockKey, { classid: string; objid: string; objsubid: number }]> = [
    ['cell_reservation org-a', lockKey('cell_reservation', 'org-a'), { classid: '4294967295', objid: '3453288545', objsubid: 1 }],
    ['cell_reservation, non-ASCII org', lockKey('cell_reservation', 'org-ü/ß 7'), { classid: '0', objid: '1823047944', objsubid: 1 }],
    ['machine minutes of an org day', lockKey('machine_minutes_org_day', 'org-a', '2026-11-14'), { classid: '727002', objid: '4122789146', objsubid: 2 }],
    ['admission quota', lockKey('admission_quota'), { classid: '2309391304', objid: '2630123674', objsubid: 2 }],
    ['run stream', lockKey('run_stream', 'org-a', 'run-1'), { classid: '3560023733', objid: '3786459126', objsubid: 2 }],
    ['named lock', lockKey('named', 'pr:org-a/repo-1/7'), { classid: '3907640154', objid: '4083795978', objsubid: 2 }],
    ['external findings org', lockKey('external_findings_org', 'org-a'), { classid: '680548726', objid: '604861118', objsubid: 1 }],
    ['migration', lockKey('migration'), { classid: '0', objid: '727001', objsubid: 1 }],
];

(skip ? describe.skip : describe)('advisory locks in a real Postgres', () => {
    let pool: Pool;
    beforeAll(() => {
        pool = new Pool({ connectionString: url, max: 2 });
    });
    afterAll(async () => {
        await pool?.end();
    });

    it.each(SHIPPED)('takes the same lock as the shipped release for the %s', async (_name, key, held) => {
        const rows = await withTransaction(pool, async (client) => {
            const s = lockStatement('pg_advisory_xact_lock', key);
            await client.query(s.text, s.values);
            return (
                await client.query(`SELECT classid::text, objid::text, objsubid FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`)
            ).rows;
        });
        expect(rows).toEqual([held]);
    });

    it('rolls a failed transaction back, releases its lock and rethrows', async () => {
        const key = lockKey('cell_reservation', `org-rollback-${process.pid}`);
        await expect(
            withTransaction(pool, async (client) => {
                const s = lockStatement('pg_advisory_xact_lock', key);
                await client.query(s.text, s.values);
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        const s = lockStatement('pg_try_advisory_xact_lock', key);
        expect(await withTransaction(pool, async (client) => (await client.query(s.text, s.values)).rows[0].acquired)).toBe(true);
    });
});
