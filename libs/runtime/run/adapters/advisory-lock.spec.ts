import { lockKey, lockStatement, withTransaction } from './advisory-lock';

// The keys shipped releases build: a release that builds another key no longer excludes the one beside it.
describe('advisory lock keys', () => {
    it('keeps every namespace on the key the shipped releases take', () => {
        expect(lockKey('migration')).toEqual({ form: 'int8', values: [727001] });
        expect(lockKey('named', 'pr:org-a/repo-1/7')).toEqual({ form: 'int4_pair', values: [-387327142, -211171318] });
        expect(lockKey('run_stream', 'org-a', 'run-1')).toEqual({ form: 'int4_pair', values: [-734943563, -508508170] });
        expect(lockKey('admission_quota')).toEqual({ form: 'int4_pair', values: [-1985575992, -1664843622] });
        expect(lockKey('cell_reservation', 'org-a')).toEqual({ form: 'hashtext', values: ['runtime.cell_reservation:org-a'] });
        expect(lockKey('machine_minutes_org_day', 'org-a', '2026-11-14')).toEqual({ form: 'class_hashtext', values: [727002, 'org-a/2026-11-14'] });
        expect(lockKey('external_findings_org', 'org-a')).toEqual({ form: 'hashtextextended', values: ['org-a'] });
    });

    it('gives two Runs of one org, and one Run id in two orgs, different stream keys', () => {
        const a = lockKey('run_stream', 'org-a', 'run-1').values;
        expect(lockKey('run_stream', 'org-a', 'run-2').values).not.toEqual(a);
        expect(lockKey('run_stream', 'org-b', 'run-1').values).not.toEqual(a);
    });

    it('renders each key form as the Postgres call that reads it', () => {
        expect(lockStatement('pg_advisory_xact_lock', lockKey('cell_reservation', 'org-a'))).toEqual({
            text: 'SELECT pg_advisory_xact_lock(hashtext($1)) AS acquired',
            values: ['runtime.cell_reservation:org-a'],
        });
        expect(lockStatement('pg_try_advisory_xact_lock', lockKey('external_findings_org', 'org-a')).text).toBe(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        );
        expect(lockStatement('pg_advisory_lock', lockKey('migration')).text).toBe('SELECT pg_advisory_lock($1::bigint) AS acquired');
        expect(lockStatement('pg_advisory_unlock', lockKey('named', 'x')).text).toBe('SELECT pg_advisory_unlock($1::int, $2::int) AS acquired');
        expect(lockStatement('pg_advisory_xact_lock', lockKey('machine_minutes_org_day', 'o', 'd')).text).toBe(
            'SELECT pg_advisory_xact_lock($1::int, hashtext($2)) AS acquired',
        );
    });
});

describe('withTransaction', () => {
    const poolOf = (failing: string[]) => {
        const released: Array<unknown> = [];
        const client = {
            query: async (sql: string) => {
                if (failing.includes(sql)) throw new Error(`${sql} failed`);
                return { rows: [] };
            },
            release: (destroy?: unknown) => void released.push(destroy),
        };
        return { pool: { connect: async () => client as never }, released };
    };

    it('gives the connection back to the pool after a commit', async () => {
        const { pool, released } = poolOf([]);
        await expect(withTransaction(pool, async () => 'done')).resolves.toBe('done');
        expect(released).toEqual([undefined]);
    });

    it('gives the connection back to the pool after a rollback, with the error of the work', async () => {
        const { pool, released } = poolOf([]);
        await expect(withTransaction(pool, async () => Promise.reject(new Error('work failed')))).rejects.toThrow('work failed');
        expect(released).toEqual([undefined]);
    });

    it('destroys a connection whose rollback failed instead of pooling it mid-transaction', async () => {
        const { pool, released } = poolOf(['ROLLBACK']);
        await expect(withTransaction(pool, async () => Promise.reject(new Error('work failed')))).rejects.toThrow('work failed');
        expect(released).toEqual([true]);
    });
});
