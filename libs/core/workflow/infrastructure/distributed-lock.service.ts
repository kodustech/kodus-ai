import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

export interface DistributedLockOptions {
    ttl?: number; // Time to live in ms (optional, for auto-release)
}

export class DistributedLock {
    private released = false;
    private ttlTimer?: NodeJS.Timeout;

    constructor(
        private readonly queryRunner: QueryRunner,
        private readonly lockId: [number, number],
        ttl?: number,
        private readonly logger = createLogger(DistributedLock.name),
    ) {
        if (ttl) {
            // Auto-release after TTL. Runs on the pinned QueryRunner so
            // pg_advisory_unlock targets the session that holds the lock.
            this.ttlTimer = setTimeout(() => {
                if (!this.released) {
                    this.release().catch((error) => {
                        this.logger.error({
                            message: 'Error auto-releasing lock',
                            context: DistributedLock.name,
                            error: error instanceof Error ? error : undefined,
                            metadata: { lockId },
                        });
                    });
                }
            }, ttl);
        }
    }

    async release(): Promise<void> {
        if (this.released) {
            return; // Already released
        }
        // Claim the release path before any await so a racing TTL fire
        // can't drive a second pg_advisory_unlock / qr.release().
        this.released = true;
        if (this.ttlTimer) {
            clearTimeout(this.ttlTimer);
            this.ttlTimer = undefined;
        }

        let unlockError: Error | undefined;
        try {
            await this.queryRunner.query(
                `SELECT pg_advisory_unlock($1, $2)`,
                this.lockId,
            );
            this.logger.debug({
                message: 'Distributed lock released',
                context: DistributedLock.name,
                metadata: { lockId: this.lockId },
            });
        } catch (error) {
            unlockError =
                error instanceof Error ? error : new Error(String(error));
            this.logger.error({
                message: 'Error releasing distributed lock',
                context: DistributedLock.name,
                error: unlockError,
                metadata: { lockId: this.lockId },
            });
        }

        // Always return the pinned connection to the pool, even when
        // pg_advisory_unlock failed — holding it would leak a real TCP
        // connection. Process exit would still release the advisory
        // lock at the PG side.
        try {
            await this.queryRunner.release();
        } catch (error) {
            this.logger.error({
                message: 'Error releasing query runner',
                context: DistributedLock.name,
                error: error instanceof Error ? error : undefined,
                metadata: { lockId: this.lockId },
            });
        }

        if (unlockError) throw unlockError;
    }

    isReleased(): boolean {
        return this.released;
    }
}

@Injectable()
export class DistributedLockService {
    private readonly logger = createLogger(DistributedLockService.name);

    constructor(private readonly dataSource: DataSource) {}

    /**
     * Acquire distributed lock using PostgreSQL Advisory Lock.
     *
     * Advisory locks are bound to the Postgres session that ran
     * pg_try_advisory_lock. To make acquire/release coherent across a
     * connection pool, we pin a single QueryRunner (= one pooled
     * connection) to the lock for its entire lifetime. The same runner
     * is used to release. Without this pinning, release could land on a
     * different connection (no-op leak) and a concurrent acquire could
     * land on the holder's own connection (re-entrant false success).
     *
     * @param key - Unique lock key (e.g. `job:${jobId}`)
     * @param options - Lock options (TTL for auto-release)
     * @returns Lock object or null if could not acquire
     */
    async acquire(
        key: string,
        options: DistributedLockOptions = {},
    ): Promise<DistributedLock | null> {
        const lockId = this.hashKey(key);
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            const result = await queryRunner.query(
                `SELECT pg_try_advisory_lock($1, $2) as acquired`,
                lockId,
            );

            if (!result[0]?.acquired) {
                await queryRunner.release();
                this.logger.debug({
                    message:
                        'Could not acquire distributed lock (already in use)',
                    context: DistributedLockService.name,
                    metadata: { key, lockId },
                });
                return null;
            }

            this.logger.debug({
                message: 'Distributed lock acquired',
                context: DistributedLockService.name,
                metadata: { key, lockId, ttl: options.ttl },
            });

            return new DistributedLock(
                queryRunner,
                lockId,
                options.ttl,
                this.logger,
            );
        } catch (error) {
            // Return the pooled connection on any failure path so a
            // transient PG error doesn't leak a TCP connection per
            // attempt. Swallow runner-release errors here — the
            // original error is the one the caller cares about.
            try {
                await queryRunner.release();
            } catch {
                // ignore
            }
            this.logger.error({
                message: 'Error acquiring distributed lock',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { key, lockId },
            });
            throw error;
        }
    }

    /**
     * Hash string key to two 32-bit integers for PostgreSQL advisory lock.
     * Uses pg_try_advisory_lock(int, int) for 64-bit key space,
     * reducing collision probability from ~1/65k to ~1/4B concurrent locks.
     */
    private hashKey(key: string): [number, number] {
        // djb2 hash — first 32 bits
        let hash1 = 5381;
        for (let i = 0; i < key.length; i++) {
            hash1 = (hash1 << 5) + hash1 + key.charCodeAt(i);
            hash1 = hash1 & hash1;
        }

        // FNV-1a hash — second 32 bits (independent algorithm to minimize correlation)
        let hash2 = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) {
            hash2 ^= key.charCodeAt(i);
            hash2 = Math.imul(hash2, 0x01000193);
            hash2 = hash2 & hash2;
        }

        return [Math.abs(hash1), Math.abs(hash2)];
    }

    /**
     * Verify if lock is in use (without acquiring). Acquire-and-release
     * happens on the same QueryRunner so the test doesn't leak the
     * advisory lock when it returns false.
     */
    async isLocked(key: string): Promise<boolean> {
        const lockId = this.hashKey(key);
        const queryRunner = this.dataSource.createQueryRunner();
        try {
            await queryRunner.connect();
            const result = await queryRunner.query(
                `SELECT pg_try_advisory_lock($1, $2) as acquired`,
                lockId,
            );

            if (result[0]?.acquired) {
                // Release immediately on the same session that acquired.
                await queryRunner.query(
                    `SELECT pg_advisory_unlock($1, $2)`,
                    lockId,
                );
                return false; // Was not in use
            }

            return true; // Is in use
        } catch (error) {
            this.logger.error({
                message: 'Error checking lock status',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { key, lockId },
            });
            // On error, assume it is locked (fail-safe)
            return true;
        } finally {
            try {
                await queryRunner.release();
            } catch {
                // ignore
            }
        }
    }
}
