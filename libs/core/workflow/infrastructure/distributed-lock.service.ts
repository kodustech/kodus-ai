import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import {
    Inject,
    Injectable,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { createLogger } from '@libs/core/log/logger';

import {
    DISTRIBUTED_LOCK_REPOSITORY_TOKEN,
    IDistributedLockRepository,
} from '../domain/contracts/distributed-lock.repository.contract';
import { DistributedLockRepository } from './repositories/distributed-lock.repository';

export interface DistributedLockOptions {
    /**
     * Longest the lock may be held, in ms. The lock is released when it
     * elapses even if the holder is still working, and the database
     * enforces the same bound if the holder dies without releasing.
     */
    ttl?: number;
}

/**
 * How long a lease lasts without a heartbeat. It bounds how long a crashed
 * holder blocks everyone else, and how long a holder whose event loop is
 * stuck keeps the lock before another instance may take it. The heartbeat
 * renews it every third of that.
 */
export const LOCK_LEASE_MS = 60_000;
/** Expired leases older than this are deleted by the sweeper. */
const EXPIRED_LEASE_GRACE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export class DistributedLock {
    private released = false;
    private lost = false;
    private ttlTimer?: NodeJS.Timeout;
    private heartbeatTimer?: NodeJS.Timeout;

    constructor(
        private readonly repository: IDistributedLockRepository,
        readonly key: string,
        readonly holder: string,
        private readonly leaseMs: number,
        ttl: number | undefined,
        private readonly onSettled: (lock: DistributedLock) => void,
        private readonly logger = createLogger(DistributedLock.name),
    ) {
        this.heartbeatTimer = setInterval(
            () => void this.heartbeat(),
            Math.max(1_000, Math.floor(leaseMs / 3)),
        );
        this.heartbeatTimer.unref?.();

        if (ttl) {
            this.ttlTimer = setTimeout(() => {
                if (!this.released) {
                    this.logger.warn({
                        message:
                            'Distributed lock reached its max hold time while still held — releasing it',
                        context: DistributedLock.name,
                        metadata: { key, holder, ttl },
                    });
                    this.release().catch(() => undefined);
                }
            }, ttl);
            this.ttlTimer.unref?.();
        }
    }

    private async heartbeat(): Promise<void> {
        if (this.released || this.lost) {
            return;
        }
        try {
            const held = await this.repository.renew(
                this.key,
                this.holder,
                this.leaseMs,
            );
            if (!held && !this.released) {
                this.lost = true;
                this.stopTimers();
                this.onSettled(this);
                this.logger.warn({
                    message:
                        'Distributed lock lease was lost before release — another instance may now hold it',
                    context: DistributedLock.name,
                    metadata: {
                        key: this.key,
                        holder: this.holder,
                        leaseMs: this.leaseMs,
                    },
                });
            }
        } catch (error) {
            // The lease is still valid until it expires; the next beat
            // retries. If the database stays down past the lease, the
            // next successful beat reports the lock as lost.
            this.logger.warn({
                message: 'Distributed lock heartbeat failed — will retry',
                context: DistributedLock.name,
                error: error instanceof Error ? error : undefined,
                metadata: { key: this.key, holder: this.holder },
            });
        }
    }

    private stopTimers(): void {
        if (this.ttlTimer) {
            clearTimeout(this.ttlTimer);
            this.ttlTimer = undefined;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    async release(): Promise<void> {
        if (this.released) {
            return;
        }
        // Claim the release path before any await so a racing TTL fire
        // can't drive a second release.
        this.released = true;
        this.stopTimers();
        this.onSettled(this);

        try {
            const freed = await this.repository.release(this.key, this.holder);
            this.logger.debug({
                message: freed
                    ? 'Distributed lock released'
                    : 'Distributed lock was no longer held at release',
                context: DistributedLock.name,
                metadata: { key: this.key, holder: this.holder },
            });
        } catch (error) {
            // The lease still expires on its own within leaseMs.
            this.logger.error({
                message:
                    'Error releasing distributed lock — it frees itself when its lease expires',
                context: DistributedLock.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    key: this.key,
                    holder: this.holder,
                    leaseMs: this.leaseMs,
                },
            });
            throw error;
        }
    }

    isReleased(): boolean {
        return this.released;
    }

    /** The lease expired or was taken over before release() ran. */
    isLost(): boolean {
        return this.lost;
    }
}

/**
 * Cross-process mutual exclusion on Postgres leases (`kodus_workflow.
 * distributed_locks`).
 *
 * It used to hold a session advisory lock on a pinned pool connection. That
 * breaks behind a pooler in transaction mode — the pinned client connection
 * does not pin a server session, so two holders got the same key and the
 * lock stayed held after release — and it kept a pool connection busy for
 * as long as the lock was held. A lease is one row: every call is a single
 * statement on any connection, and the connection goes back to the pool
 * between calls.
 *
 * Trade-off: a holder that dies without releasing blocks the key until its
 * lease runs out (LOCK_LEASE_MS, or its ttl if shorter) instead
 * of the instant its session closes.
 */
@Injectable()
export class DistributedLockService implements OnModuleInit, OnModuleDestroy {
    private static sweeper: NodeJS.Timeout | null = null;

    private readonly logger = createLogger(DistributedLockService.name);
    private readonly repository: IDistributedLockRepository;
    private readonly leaseMs: number;
    private readonly held = new Set<DistributedLock>();

    constructor(
        @InjectDataSource()
        dataSource: DataSource,
        @Optional()
        @Inject(DISTRIBUTED_LOCK_REPOSITORY_TOKEN)
        repository?: IDistributedLockRepository,
    ) {
        // Every module that provides this service already resolves the
        // DataSource; building the repository here keeps the SQL in the
        // repository layer without wiring a token into each of them.
        this.repository =
            repository ?? new DistributedLockRepository(dataSource);
        this.leaseMs = LOCK_LEASE_MS;
    }

    onModuleInit(): void {
        // Nest builds one instance per providing module; one sweeper per
        // process is enough, and concurrent sweeps across processes are
        // harmless (the DELETE is idempotent).
        if (DistributedLockService.sweeper) {
            return;
        }
        DistributedLockService.sweeper = setInterval(
            () => void this.sweepExpired(),
            SWEEP_INTERVAL_MS,
        );
        DistributedLockService.sweeper.unref?.();
    }

    async onModuleDestroy(): Promise<void> {
        if (DistributedLockService.sweeper) {
            clearInterval(DistributedLockService.sweeper);
            DistributedLockService.sweeper = null;
        }
        // Hand the keys back on a graceful shutdown instead of making the
        // next instance wait out the lease.
        const locks = [...this.held];
        if (locks.length === 0) {
            return;
        }
        await Promise.allSettled(locks.map((lock) => lock.release()));
        this.logger.log({
            message: `Released ${locks.length} distributed lock(s) on shutdown`,
            context: DistributedLockService.name,
            metadata: { keys: locks.map((lock) => lock.key) },
        });
    }

    /**
     * Acquire a lock, or null when another holder has it.
     *
     * @param key - Unique lock key (e.g. `job:${jobId}`)
     * @param options - ttl: longest the lock may be held
     * @throws when the database cannot be reached — callers decide whether
     *         to fail open or closed
     */
    async acquire(
        key: string,
        options: DistributedLockOptions = {},
    ): Promise<DistributedLock | null> {
        const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
        try {
            const acquired = await this.repository.tryAcquire(
                key,
                holder,
                this.leaseMs,
                options.ttl,
            );

            if (!acquired) {
                this.logger.debug({
                    message:
                        'Could not acquire distributed lock (already in use)',
                    context: DistributedLockService.name,
                    metadata: { key },
                });
                return null;
            }

            const lock = new DistributedLock(
                this.repository,
                key,
                holder,
                this.leaseMs,
                options.ttl,
                (settled) => this.held.delete(settled),
                this.logger,
            );
            this.held.add(lock);

            this.logger.debug({
                message: 'Distributed lock acquired',
                context: DistributedLockService.name,
                metadata: {
                    key,
                    holder,
                    ttl: options.ttl,
                    leaseMs: this.leaseMs,
                },
            });

            return lock;
        } catch (error) {
            this.logger.error({
                message: 'Error acquiring distributed lock',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { key },
            });
            throw error;
        }
    }

    /**
     * Whether `key` is held right now. On a database error it answers true
     * (fail-safe: callers treat "locked" as "skip").
     */
    async isLocked(key: string): Promise<boolean> {
        try {
            return await this.repository.isHeld(key);
        } catch (error) {
            this.logger.error({
                message: 'Error checking lock status',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { key },
            });
            return true;
        }
    }

    private async sweepExpired(): Promise<void> {
        try {
            const deleted = await this.repository.deleteExpired(
                EXPIRED_LEASE_GRACE_MS,
            );
            if (deleted > 0) {
                this.logger.log({
                    message: `Deleted ${deleted} expired distributed lock lease(s) left by holders that never released`,
                    context: DistributedLockService.name,
                });
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Expired distributed lock sweep failed — retrying next cycle',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
