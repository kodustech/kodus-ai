import { PgDistributedLocks } from './locks';
import { LockScopedPg } from './lock-scoped-pg';
function fixture() {
    const client = {
        query: jest.fn(async () => ({ rows: [] })),
        release: jest.fn(),
    };
    const pool = {
        connect: jest.fn(async () => client),
        query: jest.fn(async () => ({ rows: [] })),
    };
    const locks = new PgDistributedLocks(pool as any);
    return { client, pool, locks, sql: new LockScopedPg(pool as any, locks) };
}
it('reuses a PR lock connection for explicit store transactions', async () => {
    const { pool, client, locks, sql } = fixture();
    await locks.withLock('pr', () =>
        sql.transaction(async (c) => {
            await c.query('SELECT 1');
        }),
    );
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map((c: any[]) => c[0])).toEqual(
        expect.arrayContaining(['BEGIN', 'SELECT 1', 'COMMIT']),
    );
});
it('rejects overlapping transactions on one lock client instead of nesting BEGIN', async () => {
    const { locks, sql, client } = fixture();
    await locks.withLock('pr', async () => {
        await sql.transaction(async () => {
            await expect(
                sql.transaction(async () => undefined),
            ).rejects.toThrow('runtime_nested_transaction');
        });
    });
    expect(
        client.query.mock.calls.filter((c: any[]) => c[0] === 'BEGIN'),
    ).toHaveLength(1);
});
it('never reuses a released lock client from detached asynchronous context', async () => {
    const { locks, sql, client, pool } = fixture();
    let resume!: () => void;
    let detached!: Promise<unknown>;
    let leaked: any;
    await locks.withLock('pr', async () => {
        leaked = locks.currentClient();
        detached = new Promise<void>((resolve) => {
            resume = resolve;
        }).then(() => sql.query('SELECT later'));
    });
    resume();
    await detached;
    expect(pool.query).toHaveBeenCalledWith('SELECT later');
    expect(() => leaked.query('SELECT forbidden')).toThrow(
        'runtime_lock_context_expired',
    );
    expect(
        client.query.mock.calls.some((c: any[]) => c[0] === 'SELECT forbidden'),
    ).toBe(false);
});
it('rolls back and releases a normally borrowed transaction client on failure', async () => {
    const { sql, client, pool } = fixture();
    await expect(
        sql.transaction(async () => {
            throw new Error('fixture');
        }),
    ).rejects.toThrow('fixture');
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
});
it('refuses unrelated scoped queries while a transaction owns the lock client', async () => {
    const { locks, sql } = fixture();
    await locks.withLock('pr', () =>
        sql.transaction(async () => {
            expect(() => sql.query('SELECT unrelated')).toThrow(
                'runtime_transaction_in_progress',
            );
        }),
    );
});
