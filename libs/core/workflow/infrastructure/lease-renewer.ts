import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { createLogger } from '@libs/core/log/logger';
import { resolveSessionTimeouts } from '@libs/core/infrastructure/database/typeorm/postgres-connection-env';

import { IDistributedLockRepository } from '../domain/contracts/distributed-lock.repository.contract';
import { resolvePgSslOption } from './cross-process-events.bridge';
import { RENEW_LEASE_SQL } from './repositories/distributed-lock.repository';

/**
 * Keeps held leases alive until they are released, and reports the ones
 * that were lost (taken over, or past their max hold).
 */
export interface LeaseRenewer {
    /** Starts renewing; returns the function that stops it. */
    track(
        key: string,
        holder: string,
        leaseMs: number,
        onLost: () => void,
    ): () => void;
}

const renewEvery = (leaseMs: number) => Math.max(250, Math.floor(leaseMs / 3));

/**
 * Renews from a timer on the caller's own event loop. A holder whose event
 * loop is blocked past its lease loses the lock, so production uses
 * ThreadLeaseRenewer; this one serves tests on fake timers and is the
 * fallback when a thread cannot be started.
 */
export class TimerLeaseRenewer implements LeaseRenewer {
    private readonly logger = createLogger(TimerLeaseRenewer.name);

    constructor(private readonly repository: IDistributedLockRepository) {}

    track(
        key: string,
        holder: string,
        leaseMs: number,
        onLost: () => void,
    ): () => void {
        let stopped = false;
        const timer = setInterval(async () => {
            try {
                const held = await this.repository.renew(key, holder, leaseMs);
                if (!held && !stopped) {
                    stopped = true;
                    clearInterval(timer);
                    onLost();
                }
            } catch (error) {
                // Still held until the lease runs out; the next beat retries.
                this.logger.warn({
                    message: 'Distributed lock renewal failed — will retry',
                    context: TimerLeaseRenewer.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: { key, holder },
                });
            }
        }, renewEvery(leaseMs));
        timer.unref?.();
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }
}

/**
 * Source of the renewal thread. Plain CommonJS, loaded with `eval` so it
 * needs no file of its own in the webpack bundle; `pg` resolves from the
 * app's node_modules like everywhere else.
 */
const THREAD_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { Client } = require('pg');
const { connection, renewSql } = workerData;
const leases = new Map();
let client = null;
let busy = false;

// A connection that died without an error (a restarted pooler, a dropped
// route) leaves a query waiting forever, and a lease nobody renews expires
// under a live holder. Every connect and renewal gets a deadline; past it
// the connection is thrown away and the next beat opens a new one.
function withDeadline(promise, ms, what) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(what + ' timed out after ' + ms + 'ms')), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function discard(c) {
    if (!c) return;
    if (client === c) client = null;
    try {
        if (c.connection && c.connection.stream) c.connection.stream.destroy();
    } catch (e) {}
    c.end().catch(() => {});
}

async function connect(ms) {
    const c = new Client(connection);
    c.on('error', () => discard(c));
    try {
        await withDeadline(c.connect(), ms, 'connect');
    } catch (error) {
        discard(c);
        throw error;
    }
    client = c;
    return c;
}

async function beat() {
    if (busy || leases.size === 0) return;
    const now = Date.now();
    const due = [...leases].filter(([, l]) => l.nextAt <= now);
    if (due.length === 0) return;
    // Leave room for a retry before the shortest lease in this batch ends.
    const budget = Math.max(200, Math.min(...due.map(([, l]) => l.every)));
    busy = true;
    let c = client;
    try {
        c = c || (await connect(budget));
        for (const [id, l] of due) {
            const result = await withDeadline(
                c.query(renewSql, [l.key, l.holder, l.leaseMs]),
                budget,
                'renewal',
            );
            if (!leases.has(id)) continue;
            const held = result.rows.length > 0 && result.rows[0].held === true;
            if (held) {
                l.nextAt = Date.now() + l.every;
            } else {
                leases.delete(id);
                parentPort.postMessage({ type: 'lost', id });
            }
        }
        parentPort.postMessage({ type: 'ok' });
    } catch (error) {
        // Still due: the next beat (250ms) retries on a fresh connection.
        discard(c);
        parentPort.postMessage({
            type: 'error',
            message: error && error.message ? error.message : String(error),
        });
    } finally {
        busy = false;
    }
}

setInterval(() => void beat(), 250);
parentPort.on('message', (m) => {
    if (m.type === 'track') {
        leases.set(m.id, {
            key: m.key,
            holder: m.holder,
            leaseMs: m.leaseMs,
            every: m.every,
            nextAt: Date.now() + m.every,
        });
    } else if (m.type === 'untrack') {
        leases.delete(m.id);
    }
});
`;

interface Tracked {
    key: string;
    holder: string;
    leaseMs: number;
    onLost: () => void;
}

/**
 * Renews from a worker thread with its own database connection, so a lease
 * stays alive while its holder's process is alive even when the main event
 * loop is blocked (a CPU-bound review step, a long synchronous parse).
 * That is the guarantee the old session advisory locks gave: held for as
 * long as the process holds it, gone when the process dies — here, one
 * lease later instead of at once.
 *
 * One thread per process and connection. If the thread dies it is started
 * again and every tracked lease is handed to the new one.
 */
export class ThreadLeaseRenewer implements LeaseRenewer {
    private static readonly shared = new Map<string, ThreadLeaseRenewer>();

    private readonly logger = createLogger(ThreadLeaseRenewer.name);
    private readonly tracked = new Map<string, Tracked>();
    private worker: Worker | null = null;
    private failing = false;
    private stopped = false;

    private constructor(private readonly connection: Record<string, unknown>) {}

    /**
     * The renewer for the connection described by TypeORM DataSource
     * options (the pooled connection is fine: every renewal is one
     * statement). Throws when a thread cannot be started.
     */
    static for(dataSourceOptions: Record<string, any>): ThreadLeaseRenewer {
        const ssl = resolvePgSslOption(dataSourceOptions);
        const connection: Record<string, unknown> = {
            ...(dataSourceOptions.url
                ? { connectionString: dataSourceOptions.url }
                : {
                      host: dataSourceOptions.host,
                      port: dataSourceOptions.port,
                      user: dataSourceOptions.username,
                      password: dataSourceOptions.password,
                      database: dataSourceOptions.database,
                  }),
            ...(ssl !== undefined ? { ssl } : {}),
            application_name: 'kodus-lock-renewer',
            keepAlive: true,
            connectionTimeoutMillis: 10_000,
            ...resolveSessionTimeouts(),
        };
        const id = JSON.stringify(connection);
        let renewer = ThreadLeaseRenewer.shared.get(id);
        if (!renewer) {
            renewer = new ThreadLeaseRenewer(connection);
            renewer.start();
            ThreadLeaseRenewer.shared.set(id, renewer);
        }
        return renewer;
    }

    /** Stops every renewal thread (tests and process shutdown). */
    static async stopAll(): Promise<void> {
        const renewers = [...ThreadLeaseRenewer.shared.values()];
        ThreadLeaseRenewer.shared.clear();
        await Promise.all(renewers.map((r) => r.stop()));
    }

    track(
        key: string,
        holder: string,
        leaseMs: number,
        onLost: () => void,
    ): () => void {
        const id = randomUUID();
        this.tracked.set(id, { key, holder, leaseMs, onLost });
        this.post(id);
        return () => {
            if (this.tracked.delete(id)) {
                this.worker?.postMessage({ type: 'untrack', id });
            }
        };
    }

    private post(id: string): void {
        const lease = this.tracked.get(id);
        if (!lease) return;
        this.worker?.postMessage({
            type: 'track',
            id,
            key: lease.key,
            holder: lease.holder,
            leaseMs: lease.leaseMs,
            every: renewEvery(lease.leaseMs),
        });
    }

    private start(): void {
        const worker = new Worker(THREAD_SOURCE, {
            eval: true,
            workerData: {
                connection: this.connection,
                renewSql: RENEW_LEASE_SQL,
            },
        });
        // Never keeps the process alive on its own.
        worker.unref();
        worker.on('message', (message: any) => this.onMessage(message));
        worker.on('error', (error: unknown) => {
            this.logger.error({
                message:
                    'Distributed lock renewal thread crashed — restarting it',
                context: ThreadLeaseRenewer.name,
                error: error instanceof Error ? error : undefined,
            });
        });
        worker.on('exit', () => {
            if (this.worker !== worker || this.stopped) return;
            this.worker = null;
            // Hand every live lease to a fresh thread before they expire.
            try {
                this.start();
            } catch (error) {
                this.logger.error({
                    message:
                        'Could not restart the distributed lock renewal thread — held locks expire with their lease',
                    context: ThreadLeaseRenewer.name,
                    error: error instanceof Error ? error : undefined,
                });
            }
        });
        this.worker = worker;
        for (const id of this.tracked.keys()) this.post(id);
    }

    private onMessage(message: {
        type: 'ok' | 'error' | 'lost';
        id?: string;
        message?: string;
    }): void {
        if (message.type === 'lost' && message.id) {
            const lease = this.tracked.get(message.id);
            if (!lease) return;
            this.tracked.delete(message.id);
            lease.onLost();
        } else if (message.type === 'error') {
            // One line per outage, not one per beat.
            if (!this.failing) {
                this.failing = true;
                this.logger.warn({
                    message:
                        'Distributed lock renewal is failing — held locks stay valid until their lease runs out; retrying',
                    context: ThreadLeaseRenewer.name,
                    metadata: {
                        error: message.message,
                        held: this.tracked.size,
                    },
                });
            }
        } else if (message.type === 'ok' && this.failing) {
            this.failing = false;
            this.logger.log({
                message: 'Distributed lock renewal recovered',
                context: ThreadLeaseRenewer.name,
                metadata: { held: this.tracked.size },
            });
        }
    }

    private async stop(): Promise<void> {
        this.stopped = true;
        const worker = this.worker;
        this.worker = null;
        await worker?.terminate();
    }
}
