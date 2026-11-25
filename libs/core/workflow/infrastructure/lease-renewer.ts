import { randomUUID } from 'node:crypto';
import { Worker, WorkerOptions } from 'node:worker_threads';

import { createLogger } from '@libs/core/log/logger';
import { resolveSessionTimeouts } from '@libs/core/infrastructure/database/typeorm/postgres-connection-env';

import { IDistributedLockRepository } from '../domain/contracts/distributed-lock.repository.contract';
import { resolvePgSslOption } from './cross-process-events.bridge';
import { RENEW_LEASES_SQL } from './repositories/distributed-lock.repository';

/**
 * Keeps held leases alive until they are released, and reports the ones
 * that were lost (taken over, or past their max hold).
 */
export interface LeaseRenewer {
    /**
     * Starts renewing; returns the function that stops it. `grantedAt` is
     * when the lease was asked for (main-thread clock): the lease runs from
     * then, not from whenever a blocked event loop got around to tracking it.
     */
    track(
        key: string,
        holder: string,
        leaseMs: number,
        onLost: () => void,
        grantedAt?: number,
    ): () => void;
}

const renewEvery = (leaseMs: number) => Math.max(250, Math.floor(leaseMs / 3));

/** Wait before the first renewal of a lease granted at `grantedAt`. */
const firstRenewalIn = (leaseMs: number, grantedAt: number) =>
    Math.max(0, renewEvery(leaseMs) - (Date.now() - grantedAt));

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
        grantedAt: number = Date.now(),
    ): () => void {
        let stopped = false;
        let timer: NodeJS.Timeout | undefined;
        const stop = () => {
            stopped = true;
            clearTimeout(first);
            if (timer) clearInterval(timer);
        };
        const beat = async () => {
            try {
                const held = await this.repository.renew(key, holder, leaseMs);
                if (!held && !stopped) {
                    stop();
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
        };
        const first = setTimeout(() => {
            if (stopped) return;
            void beat();
            timer = setInterval(beat, renewEvery(leaseMs));
            timer.unref?.();
        }, firstRenewalIn(leaseMs, grantedAt));
        first.unref?.();
        return stop;
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
const { connection, renewManySql } = workerData;
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
        // One statement for every due lease: renewing them one by one made
        // a batch of thirty take thirty round trips, longer than a lease on
        // a slow database or a busy pooler.
        const sentAt = Date.now();
        const result = await withDeadline(
            c.query(renewManySql, [
                due.map(([, l]) => l.key),
                due.map(([, l]) => l.holder),
                due.map(([, l]) => l.leaseMs),
            ]),
            budget,
            'renewal',
        );
        const heldNow = new Set(
            result.rows.filter((r) => r.held === true).map((r) => r.lock_key + '\\u0000' + r.holder),
        );
        for (const [id, l] of due) {
            if (!leases.has(id)) continue;
            if (heldNow.has(l.key + '\\u0000' + l.holder)) {
                l.nextAt = Date.now() + l.every;
                // Held until at least sentAt + leaseMs: the database moved
                // expires_at after the query was sent.
                parentPort.postMessage({ type: 'renewed', id, at: sentAt });
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
            nextAt: Date.now() + (typeof m.delay === 'number' ? m.delay : m.every),
        });
    } else if (m.type === 'untrack') {
        leases.delete(m.id);
    }
});
`;

/**
 * The pg connection the renewal thread opens, derived from the app's
 * TypeORM DataSource options: same server, credentials and TLS as the app
 * pool. A renewal thread that cannot connect renews nothing, and every held
 * lock then expires one lease later.
 */
export function renewalConnectionConfig(
    dataSourceOptions: Record<string, any>,
    env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
    const ssl = resolvePgSslOption(dataSourceOptions);
    return {
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
        ...resolveSessionTimeouts(env),
    };
}

interface Tracked {
    key: string;
    holder: string;
    leaseMs: number;
    onLost: () => void;
    /** Main-thread clock: the lease holds at least until then. */
    confirmedUntil: number;
}

type SpawnThread = (source: string, options: WorkerOptions) => Worker;

/**
 * Longest wait between two attempts to bring a dead thread back while no
 * lease is held; with leases held it is half a renewal beat.
 */
const MAX_RESTART_DELAY_MS = 30_000;
/** A thread that ran this long before exiting did not die on start. */
const HEALTHY_RUN_MS = 60_000;

/**
 * Connection strings and passwords out of a message bound for the logs:
 * pg echoes a malformed connection string, password included, in its
 * errors, and key-based log redaction cannot see inside a message.
 */
export function redactCredentials(text: string): string {
    return text
        .replace(/(postgres(?:ql)?:\/\/)[^\s'"]+/gi, '$1***')
        .replace(/(password\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1***');
}

function redactedError(error: unknown): Error | undefined {
    if (!(error instanceof Error)) return undefined;
    // A fresh Error: the original may carry the connection string in
    // other properties too (Node's URL errors keep it in `input`).
    const safe = new Error(redactCredentials(error.message));
    safe.name = error.name;
    safe.stack = error.stack ? redactCredentials(error.stack) : undefined;
    return safe;
}

/**
 * Renews from a worker thread with its own database connection, so a lease
 * stays alive while its holder's process is alive even when the main event
 * loop is blocked (a CPU-bound review step, a long synchronous parse).
 * That is the guarantee the old session advisory locks gave: held for as
 * long as the process holds it, gone when the process dies — here, one
 * lease later instead of at once.
 *
 * One thread per process and connection. A thread that dies is started
 * again, with a growing delay when it keeps dying (capped at half a renewal
 * beat while leases are held), and gets every tracked lease. While there is
 * no thread, leases whose time runs out are reported lost, so no holder
 * believes it still holds a lock nobody renews.
 *
 * Limit: the restart runs on the main event loop. A thread that dies while
 * that loop is blocked for longer than the lease leaves the lease unrenewed
 * until the loop is back, and another holder can take the key meanwhile —
 * the same limit as a database unreachable for that long. Only a fencing
 * token checked by the protected write would close it.
 */
export class ThreadLeaseRenewer implements LeaseRenewer {
    private static readonly shared = new Map<string, ThreadLeaseRenewer>();

    private readonly logger = createLogger(ThreadLeaseRenewer.name);
    private readonly tracked = new Map<string, Tracked>();
    private worker: Worker | null = null;
    private workerStartedAt = 0;
    private failing = false;
    private stopped = false;
    /** Consecutive starts that failed or died early. */
    private restarts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private watchdog: NodeJS.Timeout | null = null;

    private constructor(
        private readonly connection: Record<string, unknown>,
        private readonly spawn: SpawnThread = (source, options) =>
            new Worker(source, options),
    ) {}

    /**
     * The renewer for the connection described by TypeORM DataSource
     * options (the pooled connection is fine: every renewal is one
     * statement). Throws when a thread cannot be started.
     */
    static for(dataSourceOptions: Record<string, any>): ThreadLeaseRenewer {
        const connection = renewalConnectionConfig(dataSourceOptions);
        const id = JSON.stringify(connection);
        let renewer = ThreadLeaseRenewer.shared.get(id);
        if (!renewer) {
            renewer = new ThreadLeaseRenewer(connection);
            renewer.start();
            ThreadLeaseRenewer.shared.set(id, renewer);
        }
        return renewer;
    }

    /** A renewer over threads made by `spawn` (tests). Not shared. */
    static overThreads(spawn: SpawnThread): ThreadLeaseRenewer {
        const renewer = new ThreadLeaseRenewer({}, spawn);
        renewer.start();
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
        grantedAt: number = Date.now(),
    ): () => void {
        const id = randomUUID();
        this.tracked.set(id, {
            key,
            holder,
            leaseMs,
            onLost,
            confirmedUntil: grantedAt + leaseMs,
        });
        // With no thread right now, the restart hands it over.
        this.post(id, firstRenewalIn(leaseMs, grantedAt));
        return () => {
            if (this.tracked.delete(id)) {
                this.worker?.postMessage({ type: 'untrack', id });
            }
        };
    }

    private post(id: string, delay: number): void {
        const lease = this.tracked.get(id);
        if (!lease) return;
        this.worker?.postMessage({
            type: 'track',
            id,
            key: lease.key,
            holder: lease.holder,
            leaseMs: lease.leaseMs,
            every: renewEvery(lease.leaseMs),
            delay,
        });
    }

    private start(): void {
        const worker = this.spawn(THREAD_SOURCE, {
            eval: true,
            workerData: {
                connection: this.connection,
                renewManySql: RENEW_LEASES_SQL,
            },
        });
        worker.on('message', (message: any) => this.onMessage(message));
        worker.on('error', (error: unknown) => {
            this.logger.error({
                message:
                    'Distributed lock renewal thread crashed — restarting it',
                context: ThreadLeaseRenewer.name,
                error: redactedError(error),
            });
        });
        worker.on('exit', () => {
            if (this.worker !== worker || this.stopped) return;
            this.worker = null;
            if (Date.now() - this.workerStartedAt >= HEALTHY_RUN_MS) {
                this.restarts = 0;
            }
            this.restarts++;
            this.scheduleRestart();
        });
        // Never keeps the process alive on its own. After the listeners:
        // adding a 'message' listener refs the port again.
        worker.unref();
        this.worker = worker;
        this.workerStartedAt = Date.now();
        this.stopWatchdog();
        // Renewed at once: part of their lease went by with no thread.
        for (const id of this.tracked.keys()) this.post(id, 0);
    }

    private scheduleRestart(): void {
        if (this.stopped || this.restartTimer) return;
        this.startWatchdog();
        // A thread that dies on every start must not become a tight loop,
        // but while a lease is held the wait stays under half a renewal
        // beat: a longer one let a crashing renewer sit out a whole lease.
        const ceiling = Math.min(
            MAX_RESTART_DELAY_MS,
            ...[...this.tracked.values()].map((lease) =>
                Math.max(250, renewEvery(lease.leaseMs) / 2),
            ),
        );
        const base = Math.min(
            ceiling,
            250 * 2 ** Math.max(0, this.restarts - 1),
        );
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        this.logger.warn({
            message: 'Distributed lock renewal thread stopped — restarting it',
            context: ThreadLeaseRenewer.name,
            metadata: {
                consecutiveRestarts: this.restarts,
                delayMs: delay,
                held: this.tracked.size,
            },
        });
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.stopped || this.worker) return;
            try {
                this.start();
            } catch (error) {
                this.logger.error({
                    message:
                        'Could not restart the distributed lock renewal thread — retrying; held locks are reported lost when their lease runs out',
                    context: ThreadLeaseRenewer.name,
                    error: redactedError(error),
                    metadata: { consecutiveRestarts: this.restarts },
                });
                this.restarts++;
                this.scheduleRestart();
            }
        }, delay);
        this.restartTimer.unref?.();
    }

    /**
     * While no thread renews, report each lease lost once its time runs
     * out. Not while a thread runs: a main loop that was blocked would
     * read renewals still queued as missing.
     */
    private startWatchdog(): void {
        if (this.watchdog) return;
        this.watchdog = setInterval(() => {
            const now = Date.now();
            for (const [id, lease] of this.tracked) {
                if (lease.confirmedUntil <= now) {
                    this.tracked.delete(id);
                    lease.onLost();
                }
            }
        }, 1_000);
        this.watchdog.unref?.();
    }

    private stopWatchdog(): void {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
    }

    private onMessage(message: {
        type: 'ok' | 'error' | 'lost' | 'renewed';
        id?: string;
        at?: number;
        message?: string;
    }): void {
        if (message.type === 'renewed' && message.id) {
            const lease = this.tracked.get(message.id);
            if (lease && typeof message.at === 'number') {
                lease.confirmedUntil = message.at + lease.leaseMs;
            }
        } else if (message.type === 'lost' && message.id) {
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
                        error: redactCredentials(message.message ?? ''),
                        held: this.tracked.size,
                    },
                });
            }
        } else if (message.type === 'ok') {
            this.restarts = 0;
            if (this.failing) {
                this.failing = false;
                this.logger.log({
                    message: 'Distributed lock renewal recovered',
                    context: ThreadLeaseRenewer.name,
                    metadata: { held: this.tracked.size },
                });
            }
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.stopWatchdog();
        const worker = this.worker;
        this.worker = null;
        await worker?.terminate();
    }
}
