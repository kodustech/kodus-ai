import { DataSource, QueryRunner } from 'typeorm';

import { IDistributedLockRepository } from '../../domain/contracts/distributed-lock.repository.contract';

/**
 * Session advisory locks behind the lease contract: what DistributedLockService
 * ran before leases, kept for installs that connect to Postgres without a
 * pooler (no direct connection configured), Kodus cloud included.
 *
 * Kept so a rolling deploy stays exclusive: pods still on the previous
 * release take these locks, with this same key hash, and a lease in a table
 * is invisible to them. Behind a pooler in transaction mode they do not work
 * (the pinned client connection does not pin a server session); leases are
 * used there.
 *
 * Each held lock pins one pooled connection until it is released, as
 * before. The lock lives as long as that session, so nothing renews it,
 * and `leaseMs`/`maxHoldMs` do not apply (DistributedLock's ttl timer still
 * releases it at its max hold).
 */
export class AdvisoryLockRepository implements IDistributedLockRepository {
    private readonly sessions = new Map<string, QueryRunner>();

    constructor(private readonly dataSource: DataSource) {}

    async tryAcquire(key: string, holder: string): Promise<boolean> {
        const runner = this.dataSource.createQueryRunner();
        try {
            await runner.connect();
            const rows = await runner.query(
                'SELECT pg_try_advisory_lock($1, $2) AS acquired',
                advisoryLockId(key),
            );
            if (!rows[0]?.acquired) {
                await runner.release();
                return false;
            }
            this.sessions.set(holder, runner);
            return true;
        } catch (error) {
            await runner.release().catch(() => undefined);
            throw error;
        }
    }

    /** The session holds the lock for as long as it is open. */
    async renew(_key: string, holder: string): Promise<boolean> {
        return this.sessions.has(holder);
    }

    async release(key: string, holder: string): Promise<boolean> {
        const runner = this.sessions.get(holder);
        if (!runner) return false;
        this.sessions.delete(holder);
        try {
            const rows = await runner.query(
                'SELECT pg_advisory_unlock($1, $2) AS released',
                advisoryLockId(key),
            );
            return !!rows[0]?.released;
        } finally {
            // Always hand the connection back: holding it would leak one
            // per failed unlock, and closing the session frees the lock.
            await runner.release().catch(() => undefined);
        }
    }

    /** Takes and gives back the lock on one session: free means not held. */
    async isHeld(key: string): Promise<boolean> {
        const runner = this.dataSource.createQueryRunner();
        try {
            await runner.connect();
            const id = advisoryLockId(key);
            const rows = await runner.query(
                'SELECT pg_try_advisory_lock($1, $2) AS acquired',
                id,
            );
            if (!rows[0]?.acquired) return true;
            await runner.query('SELECT pg_advisory_unlock($1, $2)', id);
            return false;
        } finally {
            await runner.release().catch(() => undefined);
        }
    }

    /** Nothing is stored: a lock ends with its session. */
    async deleteExpired(): Promise<number> {
        return 0;
    }
}

/**
 * The two 32-bit keys of pg_try_advisory_lock(int, int) for `key`. Must
 * stay what the previous release computes (djb2 and FNV-1a), or a rolling
 * deploy hands the same key to an old and a new pod.
 */
export function advisoryLockId(key: string): [number, number] {
    let hash1 = 5381;
    for (let i = 0; i < key.length; i++) {
        hash1 = (hash1 << 5) + hash1 + key.charCodeAt(i);
        hash1 = hash1 & hash1;
    }

    let hash2 = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        hash2 ^= key.charCodeAt(i);
        hash2 = Math.imul(hash2, 0x01000193);
        hash2 = hash2 & hash2;
    }

    return [Math.abs(hash1), Math.abs(hash2)];
}
