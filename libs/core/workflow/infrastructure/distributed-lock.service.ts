import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import {
    Inject,
    Injectable,
    OnApplicationShutdown,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { resolveDirectConnection } from '@libs/core/infrastructure/database/typeorm/postgres-connection-env';
import { createLogger } from '@libs/core/log/logger';

import {
    DISTRIBUTED_LOCK_REPOSITORY_TOKEN,
    IDistributedLockRepository,
} from '../domain/contracts/distributed-lock.repository.contract';
import {
    LeaseRenewer,
    ThreadLeaseRenewer,
    TimerLeaseRenewer,
} from './lease-renewer';
import { AdvisoryLockRepository } from './repositories/advisory-lock.repository';
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
 * How long a lease lasts without a renewal: how long a crashed holder blocks
 * everyone else. Renewals run every third of that on a separate thread
 * (lease-renewer.ts), so a holder whose main event loop is blocked keeps
 * the lock for as long as its process lives.
 */
export const LOCK_LEASE_MS = 60_000;

/**
 * What a lock is held with:
 * - advisory: a session advisory lock on a pinned connection, as releases
 *   before leases did. Pods of both releases see each other's locks during
 *   a rolling deploy. Wrong behind a pooler in transaction mode.
 * - lease: a row in kodus_workflow.distributed_locks, right on any
 *   connection.
 */
export type LockMode = 'advisory' | 'lease';

/**
 * Leases when a direct connection is configured, which is what declares a
 * pooler in front of Postgres; advisory locks otherwise, so installs without
 * a pooler (Kodus cloud included) keep the locks they had. Switching an
 * install to the pooler moves it to leases: pods still running without the
 * direct connection hold advisory locks the new ones cannot see, so roll
 * that change out with the old pods stopped first.
 */
export function lockModeFor(env: NodeJS.ProcessEnv): LockMode {
    try {
        return resolveDirectConnection(env) ? 'lease' : 'advisory';
    } catch {
        // A direct connection was set but is invalid: a pooler was meant.
        return 'lease';
    }
}

/** Optional settings; the defaults are what production runs. */
export const DISTRIBUTED_LOCK_CONFIG_TOKEN = Symbol('DistributedLockConfig');
export interface DistributedLockConfig {
    /** Lease length. Only tests shorten it, to observe expiry quickly. */
    leaseMs?: number;
    /** Who renews held leases. Defaults to a renewal thread. */
    renewer?: LeaseRenewer;
    /** Defaults to lockModeFor(process.env). */
    mode?: LockMode;
}

/** An advisory lock lives as long as its session: nothing to renew. */
const NO_RENEWAL: LeaseRenewer = { track: () => () => undefined };
/** A window taken with DistributedLockService.claim. */
export interface Claim {
    /** Frees the window for the next taker; false when it already ran out. */
    release(): Promise<boolean>;
}

/** Expired leases older than this are deleted by the sweeper. */
const EXPIRED_LEASE_GRACE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export class DistributedLock {
    private released = false;
    private lost = false;
    private ttlTimer?: NodeJS.Timeout;
    private readonly stopRenewing: () => void;

    constructor(
        private readonly repository: IDistributedLockRepository,
        renewer: LeaseRenewer,
        readonly key: string,
        readonly holder: string,
        private readonly leaseMs: number,
        ttl: number | undefined,
        private readonly onSettled: (lock: DistributedLock) => void,
        private readonly logger = createLogger(DistributedLock.name),
        /** When the lease was asked for; it runs from then. */
        grantedAt: number = Date.now(),
    ) {
        this.stopRenewing = renewer.track(
            key,
            holder,
            leaseMs,
            () => this.markLost(),
            grantedAt,
        );

        if (ttl) {
            // The database already ends the lease at the max hold; this
            // releases it promptly and says so.
            this.ttlTimer = setTimeout(
                () => {
                    if (!this.released) {
                        this.logger.warn({
                            message:
                                'Distributed lock reached its max hold time while still held — releasing it',
                            context: DistributedLock.name,
                            metadata: { key, holder, ttl },
                        });
                        this.release().catch(() => undefined);
                    }
                },
                Math.max(0, ttl - (Date.now() - grantedAt)),
            );
            this.ttlTimer.unref?.();
        }
    }

    private markLost(): void {
        if (this.released || this.lost) {
            return;
        }
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

    private stopTimers(): void {
        this.stopRenewing();
        if (this.ttlTimer) {
            clearTimeout(this.ttlTimer);
            this.ttlTimer = undefined;
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
 * Cross-process mutual exclusion on Postgres, held as LockMode says.
 *
 * Behind a pooler (a direct connection configured) it holds leases
 * (`kodus_workflow.distributed_locks`). A session advisory lock breaks
 * there: in transaction mode the pinned client connection does not pin a
 * server session, so two holders got the same key and the lock stayed held
 * after release. A lease is one row: every call is a single statement on
 * any connection. Trade-off: a holder that dies without releasing blocks
 * the key until its lease runs out (LOCK_LEASE_MS, or its ttl if shorter)
 * instead of the instant its session closes.
 *
 * Without a pooler it holds session advisory locks, as before leases, so a
 * rolling deploy from an earlier release stays exclusive.
 *
 * claim() always uses the lease table: it must expire without a release,
 * and releases before it never take those keys.
 */
@Injectable()
export class DistributedLockService
    implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
    private static sweeper: NodeJS.Timeout | null = null;

    private readonly logger = createLogger(DistributedLockService.name);
    /** Where acquire holds its locks: advisory or lease, by mode. */
    private readonly repository: IDistributedLockRepository;
    /** The lease table: claims and the sweep. */
    private readonly leases: IDistributedLockRepository;
    readonly mode: LockMode;
    private readonly leaseMs: number;
    private readonly renewer: LeaseRenewer;
    private readonly held = new Set<DistributedLock>();

    constructor(
        @InjectDataSource()
        dataSource: DataSource,
        @Optional()
        @Inject(DISTRIBUTED_LOCK_REPOSITORY_TOKEN)
        repository?: IDistributedLockRepository,
        @Optional()
        @Inject(DISTRIBUTED_LOCK_CONFIG_TOKEN)
        config?: DistributedLockConfig,
    ) {
        // Every module that provides this service already resolves the
        // DataSource; building the repository here keeps the SQL in the
        // repository layer without wiring a token into each of them.
        this.leases = repository ?? new DistributedLockRepository(dataSource);
        this.mode = config?.mode ?? lockModeFor(process.env);
        this.repository =
            this.mode === 'advisory'
                ? new AdvisoryLockRepository(dataSource)
                : this.leases;
        // A lease of 0 would be expired the moment it is taken.
        this.leaseMs =
            config?.leaseMs && config.leaseMs > 0
                ? config.leaseMs
                : LOCK_LEASE_MS;
        this.renewer =
            this.mode === 'advisory'
                ? NO_RENEWAL
                : (config?.renewer ?? this.defaultRenewer(dataSource));
    }

    private defaultRenewer(dataSource: DataSource): LeaseRenewer {
        try {
            return ThreadLeaseRenewer.for(
                dataSource.options as Record<string, any>,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not start the distributed lock renewal thread — renewing on the main event loop, where a long block can cost a held lock',
                context: DistributedLockService.name,
                error: error instanceof Error ? error : undefined,
            });
            return new TimerLeaseRenewer(this.repository);
        }
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

    onModuleDestroy(): void {
        if (DistributedLockService.sweeper) {
            clearInterval(DistributedLockService.sweeper);
            DistributedLockService.sweeper = null;
        }
    }

    /**
     * Hands the keys still held back on a graceful shutdown instead of
     * making the next instance wait out the lease. Not before: Nest runs
     * onModuleDestroy before beforeApplicationShutdown, where the worker
     * drains the jobs that hold them (a review's per-PR lock, a BYOK slot).
     * The connection may already be closed by now (TypeORM closes it in its
     * own onApplicationShutdown); the leases then lapse on their own.
     */
    async onApplicationShutdown(): Promise<void> {
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
            // The lease starts when the database grants it, at or after
            // this. Nothing renews it until the answer is handled on this
            // event loop, so a block in between eats into it.
            const askedAt = Date.now();
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

            if (Date.now() - askedAt >= this.leaseMs) {
                // A whole lease went by before this loop saw the answer
                // (blocked event loop): another holder may have the key
                // already. Give it up rather than work on an expired lease.
                this.logger.warn({
                    message:
                        'Distributed lock was granted but its lease ran out before the holder saw it — giving it up',
                    context: DistributedLockService.name,
                    metadata: {
                        key,
                        waitedMs: Date.now() - askedAt,
                        leaseMs: this.leaseMs,
                    },
                });
                await this.repository
                    .release(key, holder)
                    .catch(() => undefined);
                return null;
            }

            const lock = new DistributedLock(
                this.repository,
                this.renewer,
                key,
                holder,
                this.leaseMs,
                options.ttl,
                (settled) => this.held.delete(settled),
                this.logger,
                askedAt,
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
     * Takes `key` for `holdMs` and lets it run out: nothing renews it. Null
     * when another caller holds it. For "once per window" across processes,
     * such as one run per cron tick; `release` hands back a window that
     * will not be used.
     *
     * @throws when the database cannot be reached
     */
    async claim(key: string, holdMs: number): Promise<Claim | null> {
        const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
        // A hold of 0 would be expired the moment it is taken.
        const hold = holdMs > 0 ? holdMs : this.leaseMs;
        if (!(await this.leases.tryAcquire(key, holder, hold, hold))) {
            return null;
        }
        return { release: () => this.leases.release(key, holder) };
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
            const deleted = await this.leases.deleteExpired(
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
