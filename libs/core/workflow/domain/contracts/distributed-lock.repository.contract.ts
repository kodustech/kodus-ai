export const DISTRIBUTED_LOCK_REPOSITORY_TOKEN = Symbol(
    'DistributedLockRepository',
);

/**
 * Leases behind DistributedLockService. A lease names one holder and expires
 * on the database clock, so it means the same thing on every connection —
 * direct, PgBouncer in transaction mode or RDS Proxy — and it survives the
 * holder's connection being recycled. Every method is one statement.
 */
export interface IDistributedLockRepository {
    /**
     * Takes `key` for `holder` when it is free or its lease has expired.
     * The lease runs `leaseMs` from now, never past `maxHoldMs` from now
     * when one is given. Returns whether `holder` got it.
     */
    tryAcquire(
        key: string,
        holder: string,
        leaseMs: number,
        maxHoldMs?: number,
    ): Promise<boolean>;

    /**
     * Extends the lease of `holder` by `leaseMs`, capped by the max hold set
     * on acquire. Returns false when `holder` no longer holds `key`: it
     * expired and someone else took it, or it was released.
     */
    renew(key: string, holder: string, leaseMs: number): Promise<boolean>;

    /** Frees `key` only while `holder` holds it. Returns whether it did. */
    release(key: string, holder: string): Promise<boolean>;

    /** Whether someone holds an unexpired lease on `key`. */
    isHeld(key: string): Promise<boolean>;

    /**
     * Deletes leases that expired more than `graceMs` ago — the ones a
     * crashed holder never released. Returns how many it deleted.
     */
    deleteExpired(graceMs: number): Promise<number>;
}
