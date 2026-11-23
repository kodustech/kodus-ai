import { IDistributedLockRepository } from '../domain/contracts/distributed-lock.repository.contract';
import {
    LOCK_LEASE_MS,
    DistributedLockService,
} from './distributed-lock.service';

/**
 * Leases with the repository's semantics, on the (fake) wall clock: what
 * the service does with time — heartbeat, ttl, shutdown — is the unit here;
 * the SQL is proven by the integration spec.
 */
class InMemoryLeases implements IDistributedLockRepository {
    private rows = new Map<
        string,
        { holder: string; expiresAt: number; maxHoldUntil?: number }
    >();
    failing = false;

    private guard(): void {
        if (this.failing) throw new Error('connection refused');
    }

    async tryAcquire(
        key: string,
        holder: string,
        leaseMs: number,
        maxHoldMs?: number,
    ): Promise<boolean> {
        this.guard();
        const now = Date.now();
        const row = this.rows.get(key);
        if (row && row.expiresAt > now) return false;
        const maxHoldUntil =
            maxHoldMs === undefined ? undefined : now + maxHoldMs;
        this.rows.set(key, {
            holder,
            expiresAt: Math.min(now + leaseMs, maxHoldUntil ?? Infinity),
            maxHoldUntil,
        });
        return true;
    }

    async renew(key: string, holder: string, leaseMs: number) {
        this.guard();
        const row = this.rows.get(key);
        if (!row || row.holder !== holder) return false;
        row.expiresAt = Math.min(
            Date.now() + leaseMs,
            row.maxHoldUntil ?? Infinity,
        );
        return row.expiresAt > Date.now();
    }

    async release(key: string, holder: string) {
        this.guard();
        const row = this.rows.get(key);
        if (!row || row.holder !== holder) return false;
        this.rows.delete(key);
        return true;
    }

    async isHeld(key: string) {
        this.guard();
        const row = this.rows.get(key);
        return !!row && row.expiresAt > Date.now();
    }

    async deleteExpired() {
        return 0;
    }
}

describe('DistributedLockService', () => {
    let leases: InMemoryLeases;
    let instanceA: DistributedLockService;
    let instanceB: DistributedLockService;

    beforeEach(() => {
        jest.useFakeTimers();
        leases = new InMemoryLeases();
        instanceA = new DistributedLockService({} as any, leases);
        instanceB = new DistributedLockService({} as any, leases);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('a holder that keeps working keeps the lock well past one lease', async () => {
        const lock = await instanceA.acquire('job');

        await jest.advanceTimersByTimeAsync(LOCK_LEASE_MS * 5);

        expect(await instanceB.acquire('job')).toBeNull();
        expect(lock!.isLost()).toBe(false);
        await lock!.release();
    });

    it('a holder that stops beating loses the key to another instance after its lease', async () => {
        const lock = await instanceA.acquire('job');
        // The holder's process is stuck: no heartbeat reaches the database.
        leases.failing = true;
        await jest.advanceTimersByTimeAsync(LOCK_LEASE_MS + 1_000);
        leases.failing = false;

        const taken = await instanceB.acquire('job');
        expect(taken).not.toBeNull();

        // The next beat tells the old holder it no longer holds the key.
        await jest.advanceTimersByTimeAsync(LOCK_LEASE_MS / 3 + 100);
        expect(lock!.isLost()).toBe(true);

        // And its late release does not free the new holder.
        await lock!.release();
        expect(await instanceA.isLocked('job')).toBe(true);
        await taken!.release();
    });

    it('a lock is released when its ttl elapses, even if the holder never releases it', async () => {
        await instanceA.acquire('cron', { ttl: 5 * 60_000 });

        await jest.advanceTimersByTimeAsync(5 * 60_000 + 1);

        expect(await instanceB.acquire('cron')).not.toBeNull();
    });

    it('a graceful shutdown hands back every held lock at once', async () => {
        await instanceA.acquire('a');
        await instanceA.acquire('b');

        await instanceA.onModuleDestroy();

        expect(await instanceB.acquire('a')).not.toBeNull();
        expect(await instanceB.acquire('b')).not.toBeNull();
    });

    it('acquiring while the database is down throws, so the caller chooses fail-open or fail-closed', async () => {
        leases.failing = true;
        await expect(instanceA.acquire('job')).rejects.toThrow(
            'connection refused',
        );
    });

    it('isLocked answers "locked" when the database is down (callers skip)', async () => {
        leases.failing = true;
        expect(await instanceA.isLocked('job')).toBe(true);
    });
});
