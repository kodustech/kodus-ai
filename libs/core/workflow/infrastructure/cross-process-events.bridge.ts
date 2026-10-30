import { randomUUID } from 'node:crypto';

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Client, Pool } from 'pg';

import { createLogger } from '@libs/core/log/logger';

const PG_CHANNEL = 'kodus_cross_process_events';
const PG_TABLE = 'kodus_cross_process_events';

/**
 * Resolve the SSL option to hand to the raw `pg.Client` for the LISTEN
 * connection, mirroring what `TypeORMFactory` ultimately passes to the
 * `pg.Pool` through `extra.ssl`.
 *
 * Why this exists: TypeORM's top-level `ssl` field is a boolean flag it uses
 * to gate its own logic. The value that the underlying `pg` driver actually
 * consumes is `extra.ssl` — usually `{ rejectUnauthorized: false }` in
 * managed setups (AWS RDS, DO managed Postgres, self-hosted with self-signed
 * certs) whose CA isn't in Node's default trust store. Copying the bare
 * top-level `ssl: true` to `new Client({ ssl: true })` yields a hard TLS
 * handshake failure ("self-signed certificate in certificate chain") the
 * moment we try to connect — observed live in prod: `connect()` threw before
 * `ensureInfra()` could create the events table, and every reconnect
 * repeated the same failure.
 *
 * Precedence (matches TypeORMFactory):
 *   1. URL controls SSL (`?sslmode=` in DATABASE_URL) → don't override;
 *      passing `ssl` alongside would contradict the URL and confuse pgbouncer /
 *      TCP-proxy setups.
 *   2. `extra.ssl` present → that's the concrete object the pool uses.
 *   3. Top-level `ssl === true` → normalize to `{ rejectUnauthorized: false }`,
 *      the same choice the factory makes for managed hosts.
 *   4. Anything else (false / undefined / already an object) → pass through.
 */
export function resolvePgSslOption(
    options: Record<string, unknown>,
): boolean | { rejectUnauthorized: boolean } | undefined {
    const url = options.url;
    const urlControlsSsl =
        typeof url === 'string' && /[?&]sslmode=/i.test(url);
    if (urlControlsSsl) return undefined;

    const extra = options.extra as Record<string, unknown> | undefined;
    if (extra && extra.ssl !== undefined) {
        return extra.ssl as boolean | { rejectUnauthorized: boolean };
    }

    if (options.ssl === true) return { rejectUnauthorized: false };
    return options.ssl as
        | boolean
        | { rejectUnauthorized: boolean }
        | undefined;
}

/**
 * Self-delivery guard. NOT process.pid: every containerized app is PID 1,
 * so a pid-based guard makes the worker and the API look like the SAME
 * process and every envelope gets dropped (found live on the hotfix
 * droplet — rows written, nothing ever re-emitted).
 */
const INSTANCE_ID = randomUUID();
/** Rows older than this are garbage; cleaned opportunistically. */
const ROW_TTL_MINUTES = 60;

/**
 * Cap on concurrent `deliverById()` fetches. Once at this many in flight,
 * new notifications are dropped with a warning instead of piling up on
 * the pool waiting queue — the exact failure mode of the 2026-07-31
 * incident, where restarts were the only way to drain the pile. Dropped
 * events can be recovered by the polling fallback below.
 *
 * Sized to be well above what any healthy 5-slot bridge pool can drive
 * (~5 queries × ~10 events per SELECT batch) but small enough that
 * queueing can never become a hidden failure mode.
 */
const DELIVER_INFLIGHT_LIMIT = 50;

/**
 * How long forward() buffers envelopes before flushing them as one
 * multi-row INSERT + one pg_notify. Every commit that calls NOTIFY grabs
 * a Postgres-global lock (see DBOS write-up); coalescing many envelopes
 * into a single commit reduces that lock contention linearly. 50ms is
 * short enough to be invisible to the SSE endpoints on the receive side
 * while covering typical review-emission bursts.
 */
const FORWARD_FLUSH_INTERVAL_MS = 50;

/**
 * Cap on how many envelopes a single flush combines. Bounds the size of
 * the INSERT (parameter count) and the NOTIFY payload (which has an 8KB
 * Postgres limit; even at 10 chars per id — very conservative — 200 ids
 * is ~2KB with commas). Any excess spills to the next flush window.
 */
const FORWARD_FLUSH_MAX_BATCH = 200;

/**
 * Bound on the LRU of envelope ids this instance has already delivered
 * locally. Used to keep the polling fallback from re-emitting an
 * envelope that the LISTEN path already handled on THIS SAME instance
 * (LISTEN emits + poll runs later and would see the same row).
 *
 * IMPORTANT: this dedup is only WITHIN one process. Two API tasks each
 * have their own set — they both LISTEN, both poll, and both emit into
 * their own local EventEmitter2. That's expected: handlers subscribed
 * to those local events (e.g. KodyRulesSyncListener, the SSE endpoint)
 * must be idempotent across processes, and the ones that need
 * exclusivity already use `kodus_event_claims` for cross-process
 * mutual exclusion.
 *
 * 10k ids ≈ ~90KB of memory; comfortably covers hours of steady-state
 * traffic (~1.5k envelopes/hour × TTL 60min).
 */
const DELIVERED_IDS_LRU_CAP = 10_000;

/**
 * Events that must survive the process boundary. Everything else on the
 * EventEmitter2 bus stays process-local.
 *
 * Why this exists: several product features are wired as in-process
 * EventEmitter2 events whose emit site and consumer live in DIFFERENT
 * processes on the split topology (self-hosted default):
 *
 *   - `pull-request.closed` is emitted by the webhook PR handlers, which
 *     execute in the WORKER (the webhook queue consumer lives there),
 *     while its listeners — KodyRulesSyncListener (repo rule-file sync)
 *     and CentralizedConfigSyncListener — are registered in the API
 *     module tree. Result: PR-driven rule sync and centralized-config
 *     sync silently never ran on self-hosted.
 *   - `pr-execution.updated` is emitted by AutomationExecutionService in
 *     the review pipeline (worker) and consumed by the API's SSE endpoint
 *     (/pull-requests/executions/events). Result: the UI's live execution
 *     status only ever showed heartbeats.
 *
 * Registering the listener modules in the worker is not viable: the
 * KodyRules module graph deadlocks the worker's Nest boot (forwardRef
 * cycles), and the SSE consumer is an HTTP endpoint that must live in
 * the API regardless.
 */
const FORWARDED_EVENTS = ['pull-request.closed', 'pr-execution.updated'];

/** Marker stamped on re-emitted payloads so the forwarder never loops. */
const BRIDGED_FLAG = '__kodusBridged';

interface BridgeEnvelope {
    instanceId: string;
    name: string;
    payload: Record<string, unknown>;
}

/**
 * Cross-process delivery for the events in `FORWARDED_EVENTS`, over
 * Postgres LISTEN/NOTIFY on the shared main database — no new
 * infrastructure, at-most-once delivery.
 *
 * Publish half: `@OnEvent` forwarders pick the events up from the LOCAL
 * bus (emit sites stay untouched) and `pg_notify` them with this
 * process's pid. Subscribe half: a dedicated LISTEN connection re-emits
 * incoming envelopes into the LOCAL bus, skipping the process's own
 * envelopes (pid guard) so monolithic deployments don't double-deliver.
 * Re-emitted payloads carry `__kodusBridged` so the forwarder ignores
 * them and nothing ping-pongs.
 *
 * Registered in WorkflowModule's shared providers — the one module both
 * the API and the worker load.
 *
 * NOTIFY payloads are capped at 8KB by Postgres; the forwarded events
 * carry small metadata objects (org/repo/PR ids, file lists). Oversized
 * payloads are dropped with a warning rather than failing the emit site.
 */
@Injectable()
export class CrossProcessEventsBridge implements OnModuleInit, OnModuleDestroy {
    /**
     * Nest instantiates this provider once PER IMPORTING MODULE CONTEXT —
     * observed live: two instances in the API process, meaning every local
     * event was forwarded twice (2 envelopes/merge) and every envelope was
     * re-emitted twice (4 listener firings/merge → duplicated Kody Rules).
     * Only the first constructed instance is active; the rest are inert.
     */
    private static primary: CrossProcessEventsBridge | null = null;

    private readonly logger = createLogger(CrossProcessEventsBridge.name);
    private client: Client | null = null;
    private stopped = false;
    private reconnectDelayMs = 1_000;

    /**
     * Dedicated pg.Pool for the bridge's own queries (INSERT in forward,
     * SELECT in deliverById, DELETE in sweep). Separate from the API's
     * main TypeORM pool so a bridge misbehaving under burst cannot starve
     * HTTP handlers / crons / other consumers of the main pool.
     *
     * Small on purpose: `max=5` is enough to sustain thousands of
     * envelopes/hour with the batch path (see forward/deliverById) and
     * caps blast radius if a query does hang. If this pool saturates,
     * the API's HTTP pool stays untouched — the bridge degrades in
     * isolation, which is the whole point of separating it.
     */
    private bridgePool: Pool | null = null;

    /**
     * Observation-only metrics — accumulated between periodic flushes and
     * printed with the `[BRIDGE-METRIC]` prefix so `docker logs -f | grep`
     * gives a live view of saturation. Reset each flush window, no cost path.
     */
    private metrics = {
        forwarded: 0,
        forwardErrors: 0,
        insertMs: [] as number[],
        notifyMs: [] as number[],
        notifyReceived: 0,
        delivered: 0,
        deliverErrors: 0,
        deliverDropped: 0, // over-limit drops (see DELIVER_INFLIGHT_LIMIT)
        envelopeMissing: 0,
        selectMs: [] as number[],
        lagMs: [] as number[],
    };
    private inflightDeliveries = 0;
    private metricsTimer: NodeJS.Timeout | null = null;

    /**
     * Interval handles for the background maintenance loops. We use
     * setInterval instead of `@Cron` because Nest instantiates this
     * provider once per importing module context — with `@Cron` the
     * scheduler ends up bound to an INERT duplicate instance whose
     * isPrimary guard skips every tick, so polling and TTL sweep never
     * actually run. Explicit intervals armed in onModuleInit of the
     * primary instance don't have that ambiguity.
     */
    private pollTimer: NodeJS.Timeout | null = null;
    private sweepTimer: NodeJS.Timeout | null = null;

    /**
     * High-water mark of ids seen by the polling fallback (below). Kept
     * in memory: on a fresh process the poll starts from the current
     * MAX(id) — we do NOT want to replay the entire live window into a
     * cold consumer (would trigger every listener for every merged PR
     * in the last hour). The row table + the LISTEN path are still
     * authoritative for real-time delivery; polling is a safety net.
     */
    private pollLastSeenId = 0n;
    private pollInitialized = false;

    /**
     * LRU of ids this process has already emitted locally, via LISTEN
     * or via polling. Keeps the polling fallback from re-firing handlers
     * for envelopes already delivered on this same instance.
     * See DELIVERED_IDS_LRU_CAP.
     */
    private deliveredIds: Set<string> = new Set();
    private markDelivered(id: string | number | bigint): void {
        const key = String(id);
        if (this.deliveredIds.has(key)) return;
        if (this.deliveredIds.size >= DELIVERED_IDS_LRU_CAP) {
            // Set preserves insertion order — drop the oldest entry
            // (which is the first iteration of keys()) to keep memory
            // bounded without any external LRU dependency.
            const oldest = this.deliveredIds.values().next().value;
            if (oldest !== undefined) this.deliveredIds.delete(oldest);
        }
        this.deliveredIds.add(key);
    }

    // Forward-side batching state (see FORWARD_FLUSH_* constants above).
    private forwardBuffer: string[] = [];
    private forwardFlushTimer: NodeJS.Timeout | null = null;
    // In-flight flush promises tracked so onModuleDestroy can drain
    // before the pool closes — losing envelopes on shutdown is fine
    // (polling fallback recovers), but crashing on "pool ended" is not.
    private forwardFlushInFlight: Promise<void> | null = null;

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        private readonly eventEmitter: EventEmitter2,
    ) {
        if (!CrossProcessEventsBridge.primary) {
            CrossProcessEventsBridge.primary = this;
        }
    }

    /** Exposed for tests. */
    get isPrimary(): boolean {
        return CrossProcessEventsBridge.primary === this;
    }

    /** Test hook: reset the singleton between spec cases. */
    static resetPrimaryForTests(): void {
        CrossProcessEventsBridge.primary = null;
    }

    async onModuleInit(): Promise<void> {
        if (!this.isPrimary) {
            this.logger.warn({
                message:
                    'Duplicate CrossProcessEventsBridge instance detected — staying inert (no LISTEN, no forwarding)',
                context: CrossProcessEventsBridge.name,
            });
            return;
        }
        // Build the dedicated pool up front — cheap, and having it
        // available before the first forward()/deliverById avoids a
        // null-check on the hot path.
        this.bridgePool = this.createBridgePool();
        // Fire and forget: LISTEN connectivity must never block boot.
        void this.connect();
        this.startMetricsLogger();
        this.startMaintenanceLoops();
    }

    /**
     * Arm the two background loops that keep the row store healthy:
     *   - pollFallback (10s): safety net for envelopes missed by LISTEN
     *     during reconnect windows / NOTIFY overflow
     *   - sweepExpiredRows (10min): drop rows past the TTL so the table
     *     stays small
     *
     * Both were `@Cron` before; that ended up firing on Nest's INERT
     * duplicate instance, so nothing ran. Explicit setInterval on the
     * primary avoids that whole class of bug.
     */
    private startMaintenanceLoops(): void {
        if (!this.isPrimary) return;
        this.pollTimer = setInterval(() => {
            void this.pollFallback();
        }, 10_000);
        this.pollTimer.unref?.();
        this.sweepTimer = setInterval(
            () => {
                void this.sweepExpiredRows();
            },
            10 * 60 * 1000,
        );
        this.sweepTimer.unref?.();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
            this.metricsTimer = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        if (this.forwardFlushTimer) {
            clearTimeout(this.forwardFlushTimer);
            this.forwardFlushTimer = null;
        }
        // Drain any pending flush before the pool goes away —
        // otherwise the flush lands on a closed pool and throws.
        await this.forwardFlushInFlight?.catch(() => undefined);
        // Attempt one final flush of whatever's still buffered. If it
        // fails, we lose those envelopes on shutdown; the polling
        // fallback recovers them from the row store on the next boot.
        if (this.forwardBuffer.length > 0) {
            await this.doFlush(this.forwardBuffer.splice(0)).catch(
                () => undefined,
            );
        }
        await this.client?.end().catch(() => undefined);
        this.client = null;
        await this.bridgePool?.end().catch(() => undefined);
        this.bridgePool = null;
    }

    /**
     * Build the dedicated pg.Pool for the bridge. Mirrors the connection
     * config resolution used by the LISTEN client (see connect()) so both
     * live under the same host / auth / SSL rules — driven from the
     * running TypeORM DataSource options so nothing needs a separate env.
     */
    private createBridgePool(): Pool {
        const options = this.dataSource.options as Record<string, any>;
        const ssl = resolvePgSslOption(options);
        const commonPoolOpts = {
            max: 5,
            min: 0,
            idleTimeoutMillis: 60_000,
            connectionTimeoutMillis: 10_000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
            application_name: 'kodus-bridge-pool',
            statement_timeout: 30_000,
            idle_in_transaction_session_timeout: 60_000,
        } as const;
        const pool = new Pool(
            options.url
                ? {
                      connectionString: options.url,
                      ...(ssl !== undefined ? { ssl } : {}),
                      ...commonPoolOpts,
                  }
                : {
                      host: options.host,
                      port: options.port,
                      user: options.username,
                      password: options.password,
                      database: options.database,
                      ...(ssl !== undefined ? { ssl } : {}),
                      ...commonPoolOpts,
                  },
        );
        // MANDATORY error handler on pg.Pool. Without this, an error on
        // an idle pool client (RDS terminating an idle conn, network
        // reset, admin `pg_terminate_backend`) escapes as an uncaught
        // exception and CRASHES THE PROCESS. Discovered live during the
        // 2026-07-31 stress tests: killing a bridge-pool conn brought
        // the whole API down with `[BOOTSTRAP-EARLY] uncaughtException:
        // terminating connection due to administrator command`.
        pool.on('error', (error) => {
            this.logger.warn({
                message:
                    'Bridge pool client errored — pg.Pool will drop it and open a new one on next query',
                context: CrossProcessEventsBridge.name,
                error,
            });
        });
        return pool;
    }

    @OnEvent('pull-request.closed')
    async forwardPullRequestClosed(payload: unknown): Promise<void> {
        await this.forward('pull-request.closed', payload);
    }

    @OnEvent('pr-execution.updated')
    async forwardPrExecutionUpdated(payload: unknown): Promise<void> {
        await this.forward('pr-execution.updated', payload);
    }

    /**
     * Whether a local event should be forwarded to other processes.
     * Exposed for tests: re-emitted (bridged) payloads must not loop.
     */
    shouldForward(payload: unknown): payload is Record<string, unknown> {
        return Boolean(
            this.isPrimary &&
            payload &&
            typeof payload === 'object' &&
            !(payload as Record<string, unknown>)[BRIDGED_FLAG],
        );
    }

    /** Exposed for tests. */
    readonly instanceId = INSTANCE_ID;

    /**
     * Whether a received envelope should be re-emitted locally: never our
     * own (instance guard — the local bus already delivered it here).
     */
    shouldReemit(envelope: BridgeEnvelope | null | undefined): boolean {
        return Boolean(
            envelope &&
            envelope.name &&
            FORWARDED_EVENTS.includes(envelope.name) &&
            envelope.instanceId !== INSTANCE_ID,
        );
    }

    private async forward(name: string, payload: unknown): Promise<void> {
        if (!this.shouldForward(payload)) return;

        const envelope: BridgeEnvelope = {
            instanceId: INSTANCE_ID,
            name,
            payload,
        };
        let serialized: string;
        try {
            serialized = JSON.stringify(envelope);
        } catch {
            return; // non-serializable payload — local-only event
        }

        // Enqueue for the next flush window. Emit sites stay
        // effectively synchronous (push into an array + schedule) —
        // Nest's @OnEvent handlers finish immediately, and the actual
        // INSERT/NOTIFY happens on the flush timer below.
        this.forwardBuffer.push(serialized);
        if (this.forwardBuffer.length >= FORWARD_FLUSH_MAX_BATCH) {
            // Big burst → flush immediately, don't wait the 50ms.
            void this.flushForwardBuffer();
        } else {
            this.scheduleForwardFlush();
        }
    }

    private scheduleForwardFlush(): void {
        if (this.forwardFlushTimer) return;
        this.forwardFlushTimer = setTimeout(() => {
            this.forwardFlushTimer = null;
            void this.flushForwardBuffer();
        }, FORWARD_FLUSH_INTERVAL_MS);
        this.forwardFlushTimer.unref?.();
    }

    /**
     * Drain the buffer as ONE multi-row INSERT + ONE pg_notify carrying
     * the comma-joined id list. Under burst this collapses N NOTIFY
     * commits (each grabbing the global lock) into one, which is the
     * main throughput win the DBOS post describes.
     *
     * Serialized: the `forwardFlushInFlight` guard makes concurrent
     * flushes reuse the pending promise, so on a 500ms flush window
     * further pushes just wait one turn instead of stacking.
     */
    /**
     * Deterministically drains the buffer NOW instead of waiting the
     * 50ms window. Test-only: `forward()` becomes effectively
     * synchronous when the test awaits this after the emit.
     */
    async flushForwardBufferForTests(): Promise<void> {
        await this.flushForwardBuffer();
    }

    private async flushForwardBuffer(): Promise<void> {
        if (this.forwardFlushInFlight) {
            // Chain onto the pending flush; the new envelopes stay in
            // the buffer and are picked up by the tail call.
            await this.forwardFlushInFlight;
        }
        if (this.forwardBuffer.length === 0) return;

        // Clear the flush timer up front (a new one arms as soon as
        // the next push happens after the drain starts).
        if (this.forwardFlushTimer) {
            clearTimeout(this.forwardFlushTimer);
            this.forwardFlushTimer = null;
        }

        const batch = this.forwardBuffer.splice(
            0,
            FORWARD_FLUSH_MAX_BATCH,
        );

        this.forwardFlushInFlight = this.doFlush(batch).finally(() => {
            this.forwardFlushInFlight = null;
            // Anything that came in during the flush now gets its own
            // window scheduled.
            if (this.forwardBuffer.length > 0) {
                this.scheduleForwardFlush();
            }
        });
        await this.forwardFlushInFlight;
    }

    private async doFlush(batch: string[]): Promise<void> {
        try {
            const t0 = Date.now();
            // Build the multi-row VALUES list: ($1::jsonb),($2::jsonb),...
            const placeholders = batch
                .map((_, i) => `($${i + 1}::jsonb)`)
                .join(',');
            const insertRows = await this.runQuery<{ id: string }>(
                `INSERT INTO ${PG_TABLE} (envelope) VALUES ${placeholders} RETURNING id`,
                batch,
            );
            const t1 = Date.now();
            this.metrics.insertMs.push(t1 - t0);
            const ids = insertRows
                .map((r) => r?.id)
                .filter((id): id is string => id !== undefined && id !== null);
            if (ids.length === 0) {
                throw new Error('insert returned no ids');
            }
            // Comma-joined id list; deliverBatch on the receive side
            // parses on ',' and falls back to single-id handling if a
            // legacy notify (single id, no comma) is heard.
            await this.runQuery('SELECT pg_notify($1, $2)', [
                PG_CHANNEL,
                ids.join(','),
            ]);
            this.metrics.notifyMs.push(Date.now() - t1);
            this.metrics.forwarded += ids.length;
        } catch (error) {
            this.metrics.forwardErrors += batch.length;
            this.logger.warn({
                message: `Failed to forward ${batch.length} events across processes (local delivery unaffected)`,
                context: CrossProcessEventsBridge.name,
                error,
            });
        }
    }

    /**
     * Route every bridge query through the dedicated `bridgePool` when
     * it's initialized, and fall back to the main `dataSource` otherwise
     * (test suites that construct the bridge without running
     * onModuleInit; the very first call in edge cases). Normalizes the
     * two return shapes — pg.Pool returns `{rows}`, TypeORM returns rows
     * directly — into a plain array so callers don't care which path
     * served the query.
     */
    private async runQuery<T = any>(
        sql: string,
        params?: unknown[],
    ): Promise<T[]> {
        const pool = this.bridgePool;
        if (pool) {
            const result = await pool.query<T>(sql, params as any);
            return result.rows ?? [];
        }
        const rows = (await this.dataSource.query(sql, params)) as T[];
        return rows ?? [];
    }

    private infraReady = false;

    /**
     * Ensure the events table exists — runs at most ONCE per process
     * lifetime. Previously this ran on every reconnect and also did a
     * TTL sweep DELETE using the main pool, which held a pool slot
     * during the very window when the LISTEN was down and pg_notify
     * bursts from workers arrived and were dropped (root cause of the
     * 2026-07-31 pool exhaustion). The DELETE is now `sweepExpiredRows`
     * below, on its own @Cron.
     */
    private async ensureInfra(): Promise<void> {
        if (this.infraReady) return;
        await this.runQuery(
            `CREATE TABLE IF NOT EXISTS ${PG_TABLE} (
                id bigserial PRIMARY KEY,
                envelope jsonb NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            )`,
        );
        this.infraReady = true;
    }

    /**
     * Periodic TTL sweep — decoupled from the reconnect path. Runs on the
     * primary instance only so the DELETE isn't fanned out to every API/
     * worker process. Backed by the `created_at` index (see migration
     * 2026071300000000-CrossProcessEventsTable.ts). Runs every 15 min:
     * fast enough to keep the table small (<3k rows in steady state at
     * ~1.5k envelopes/hour), rare enough that any accidental full-table
     * scan can't turn into a hot loop.
     */
    /**
     * Safety-net poller: catches envelopes that the LISTEN half missed —
     * during the reconnect window after an idle drop, during a brief
     * network blip, or during a NOTIFY spike that overflowed pg's
     * notification queue. Runs on the primary only.
     *
     * On first run, anchors `pollLastSeenId` to the current MAX(id) so
     * a freshly booted process doesn't replay the whole live window
     * (which would fire every listener for every merged PR in the last
     * hour). From then on, only NEW rows since the last tick are
     * delivered — the instance-id guard in `shouldReemit` still
     * prevents the primary from re-emitting its own envelopes.
     *
     * The cadence (10s) is short enough that a dropped NOTIFY is
     * observed within seconds — long before the 60min TTL sweep
     * removes the row.
     */
    async pollFallback(): Promise<void> {
        if (!this.isPrimary || this.stopped || !this.infraReady) return;
        try {
            if (!this.pollInitialized) {
                // Anchor to a stable MAX(id) — apply the same 1s visibility
                // gap as the working query below, otherwise the first anchor
                // could bind to an id whose row is still pre-commit and
                // gets replayed on the second tick anyway.
                const anchor = await this.runQuery<{ max: string | null }>(
                    `SELECT COALESCE(MAX(id), 0)::text AS max FROM ${PG_TABLE}
                        WHERE created_at < now() - interval '1 second'`,
                );
                const maxId = anchor?.[0]?.max ?? '0';
                this.pollLastSeenId = BigInt(maxId);
                this.pollInitialized = true;
                return;
            }
            // 1-second visibility gap: bigserial hands out ids BEFORE
            // commit, so a row inserted concurrently with a poll can be
            // "id-visible but row-invisible" and slip past the WHERE id
            // > $1 boundary forever. Only reading rows whose created_at
            // is at least a second old guarantees the commit landed —
            // NOTIFY has already delivered the fresh ones anyway; this
            // path is the SAFETY NET for envelopes NOTIFY missed.
            const rows = await this.runQuery<{
                id: string;
                envelope: BridgeEnvelope;
                created_at: Date;
            }>(
                `SELECT id, envelope, created_at FROM ${PG_TABLE}
                    WHERE id > $1
                      AND created_at < now() - interval '1 second'
                    ORDER BY id
                    LIMIT 500`,
                [this.pollLastSeenId.toString()],
            );
            if (rows.length === 0) return;
            const now = Date.now();
            for (const row of rows) {
                const idBig = BigInt(row.id);
                if (idBig > this.pollLastSeenId) {
                    this.pollLastSeenId = idBig;
                }
                // Skip envelopes THIS instance has already emitted
                // locally (via LISTEN). Without this the poll would
                // fire handlers a second time — with 2 API tasks
                // running that's a 4× local-emit amplification
                // (2 tasks × 2 paths each). Watermark still advances
                // so we don't re-check the same row every tick.
                if (this.deliveredIds.has(String(row.id))) continue;
                if (row.created_at) {
                    this.metrics.lagMs.push(
                        now - new Date(row.created_at).getTime(),
                    );
                }
                if (this.shouldReemit(row.envelope)) {
                    this.eventEmitter.emit(row.envelope.name, {
                        ...row.envelope.payload,
                        [BRIDGED_FLAG]: true,
                    });
                    this.metrics.delivered++;
                    this.markDelivered(row.id);
                }
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Cross-process events polling fallback failed — will retry next tick',
                context: CrossProcessEventsBridge.name,
                error,
            });
        }
    }

    async sweepExpiredRows(): Promise<void> {
        if (!this.isPrimary || this.stopped || !this.infraReady) return;
        try {
            // Advisory lock so only ONE task actually runs the DELETE
            // per cycle. With 2 API tasks (typical prod), unlocked
            // DELETEs mean 2 concurrent full-table scans every 10 min
            // — Postgres serializes them (no corruption) but wastes
            // 2× the work. `pg_try_advisory_lock` returns immediately
            // (never blocks); if another task holds it we simply
            // skip this cycle and let that task do the sweep.
            //
            // Key is a stable hash of the resource name. Any Postgres
            // instance is fine — the lock lives on the DB, so all
            // API/worker tasks connected to the same DB share it.
            const lockRows = await this.runQuery<{ locked: boolean }>(
                `SELECT pg_try_advisory_lock(hashtext('kodus-bridge-sweep')) AS locked`,
            );
            if (!lockRows?.[0]?.locked) {
                // Another instance is running the sweep — no-op.
                return;
            }
            try {
                await this.runQuery(
                    `DELETE FROM ${PG_TABLE} WHERE created_at < now() - interval '${ROW_TTL_MINUTES} minutes'`,
                );
            } finally {
                await this.runQuery(
                    `SELECT pg_advisory_unlock(hashtext('kodus-bridge-sweep'))`,
                ).catch(() => undefined);
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Cross-process events TTL sweep failed — will retry next tick',
                context: CrossProcessEventsBridge.name,
                error,
            });
        }
    }

    /**
     * Batched delivery: one SELECT for a burst of ids received in a
     * single NOTIFY payload. Counterpart of the batched forward flush —
     * without this, N ids in one NOTIFY would fan out to N SELECTs and
     * defeat the whole batching win. The semaphore still applies: each
     * envelope emit slot counts toward DELIVER_INFLIGHT_LIMIT.
     */
    private async deliverBatch(ids: number[]): Promise<void> {
        this.metrics.notifyReceived += ids.length;
        if (this.inflightDeliveries + ids.length > DELIVER_INFLIGHT_LIMIT) {
            // Bounded concurrency: reject the whole batch when it
            // wouldn't fit. The polling fallback will still pick these
            // up as long as they're within the TTL window.
            this.metrics.deliverDropped += ids.length;
            return;
        }
        this.inflightDeliveries += ids.length;
        try {
            const t0 = Date.now();
            const rows = await this.runQuery<{
                id: string;
                envelope: BridgeEnvelope;
                created_at: Date;
            }>(
                `SELECT id, envelope, created_at FROM ${PG_TABLE} WHERE id = ANY($1::bigint[])`,
                [ids],
            );
            this.metrics.selectMs.push(Date.now() - t0);
            const now = Date.now();
            const seenIds = new Set<string>();
            for (const row of rows) {
                seenIds.add(String(row.id));
                if (row.created_at) {
                    this.metrics.lagMs.push(
                        now - new Date(row.created_at).getTime(),
                    );
                }
                if (this.shouldReemit(row.envelope)) {
                    this.eventEmitter.emit(row.envelope.name, {
                        ...row.envelope.payload,
                        [BRIDGED_FLAG]: true,
                    });
                    this.metrics.delivered++;
                    this.markDelivered(row.id);
                }
            }
            // Rows expected but not found are envelopes swept by TTL
            // (or lost); reported separately from delivery errors.
            this.metrics.envelopeMissing += ids.length - seenIds.size;
        } catch (error) {
            this.metrics.deliverErrors += ids.length;
            this.logger.warn({
                message:
                    'Failed to fetch cross-process event envelopes batch — events skipped in this process',
                context: CrossProcessEventsBridge.name,
                error,
                metadata: { count: ids.length },
            });
        } finally {
            this.inflightDeliveries -= ids.length;
        }
    }

    private async deliverById(rawId: string): Promise<void> {
        const id = Number(rawId);
        if (!Number.isFinite(id)) return;
        this.metrics.notifyReceived++;
        // Bounded concurrency (see DELIVER_INFLIGHT_LIMIT above). When the
        // bridge pool is saturated, dropping the fetch here — instead of
        // queueing it on a pending promise — keeps the event loop
        // responsive. The polling fallback re-delivers dropped envelopes
        // as long as they're still within the TTL window.
        if (this.inflightDeliveries >= DELIVER_INFLIGHT_LIMIT) {
            this.metrics.deliverDropped++;
            return;
        }
        this.inflightDeliveries++;
        try {
            const t0 = Date.now();
            const rows = await this.runQuery<{
                envelope: BridgeEnvelope;
                created_at: Date;
            }>(
                `SELECT envelope, created_at FROM ${PG_TABLE} WHERE id = $1`,
                [id],
            );
            this.metrics.selectMs.push(Date.now() - t0);
            const row = rows?.[0];
            const envelope = row?.envelope;
            const createdAt = row?.created_at;
            if (createdAt) {
                this.metrics.lagMs.push(Date.now() - new Date(createdAt).getTime());
            }
            if (!envelope) {
                this.metrics.envelopeMissing++;
            } else if (this.shouldReemit(envelope)) {
                this.eventEmitter.emit(envelope.name, {
                    ...envelope.payload,
                    [BRIDGED_FLAG]: true,
                });
                this.metrics.delivered++;
                this.markDelivered(id);
            }
        } catch (error) {
            this.metrics.deliverErrors++;
            this.logger.warn({
                message:
                    'Failed to fetch cross-process event envelope — event skipped in this process',
                context: CrossProcessEventsBridge.name,
                error,
                metadata: { id },
            });
        } finally {
            this.inflightDeliveries--;
        }
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;

        const options = this.dataSource.options as Record<string, any>;
        // Deployments may configure Postgres via a single URL instead of
        // discrete fields — building the client only from host/port left
        // those installs without a LISTEN connection.
        //
        // SSL: resolve via `resolvePgSslOption` (see its docstring) so the
        // raw `pg.Client` picks the same value the pool uses — a bare
        // `ssl: true` fails handshake against RDS/self-signed setups.
        const ssl = resolvePgSslOption(options);
        // Connection hardening (added 2026-07-31 after prod incident):
        //   - keepAlive: TCP-level probes stop the LISTEN connection from
        //     looking idle to RDS. Prod's `idle_session_timeout = 1h` was
        //     killing it hourly; every kill triggered a reconnect whose
        //     ensureInfra() DELETE held a pool slot and shadowed a burst
        //     of pg_notify from the workers.
        //   - application_name: makes this connection identifiable in
        //     `pg_stat_activity` so incident triage doesn't guess.
        //   - connectionTimeoutMillis: bounds the initial connect() so a
        //     network blackhole can't hang the reconnect loop forever.
        //   - statement_timeout: bridge never runs long queries on this
        //     connection (only `LISTEN`), so any query that outlives 30s
        //     is a bug — kill it fast.
        //   - idle_in_transaction_session_timeout: belt-and-suspenders in
        //     case anything ever accidentally opens a tx on this client.
        const clientCommonOpts = {
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
            connectionTimeoutMillis: 10_000,
            application_name: 'kodus-bridge-listener',
            statement_timeout: 30_000,
            idle_in_transaction_session_timeout: 60_000,
        } as const;
        const client = new Client(
            options.url
                ? {
                      connectionString: options.url,
                      ...(ssl !== undefined ? { ssl } : {}),
                      ...clientCommonOpts,
                  }
                : {
                      host: options.host,
                      port: options.port,
                      user: options.username,
                      password: options.password,
                      database: options.database,
                      ...(ssl !== undefined ? { ssl } : {}),
                      ...clientCommonOpts,
                  },
        );

        client.on('error', (error) => {
            this.logger.warn({
                message:
                    'Cross-process LISTEN connection errored — reconnecting',
                context: CrossProcessEventsBridge.name,
                error,
            });
            void this.scheduleReconnect(client);
        });

        client.on('notification', (msg) => {
            if (msg.channel !== PG_CHANNEL || !msg.payload) return;
            // Payload is either a single id ("77") from the old code
            // path or a comma-joined list ("77,78,79") from the new
            // batched flush. Parsing on ',' handles both — a single id
            // yields a length-1 array.
            // Number('') is 0 (not NaN), so filter empty parts BEFORE
            // parsing — otherwise an empty payload becomes id=0 and we
            // waste a SELECT on a non-existent row.
            const ids = msg.payload
                .split(',')
                .map((raw) => raw.trim())
                .filter((raw) => raw.length > 0)
                .map((raw) => Number(raw))
                .filter((n) => Number.isFinite(n) && n > 0);
            if (ids.length === 1) {
                void this.deliverById(String(ids[0]));
            } else if (ids.length > 1) {
                void this.deliverBatch(ids);
            }
        });

        try {
            await client.connect();
            // Shutdown may have started while the connect was in flight —
            // don't leave a dangling LISTEN connection behind.
            if (this.stopped) {
                await client.end().catch(() => undefined);
                return;
            }
            await this.ensureInfra();
            await client.query(`LISTEN ${PG_CHANNEL}`);
            this.client = client;
            this.reconnectDelayMs = 1_000;
            this.logger.log({
                message: `Listening on ${PG_CHANNEL} (cross-process event bridge: ${FORWARDED_EVENTS.join(', ')})`,
                context: CrossProcessEventsBridge.name,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not establish cross-process LISTEN connection — retrying',
                context: CrossProcessEventsBridge.name,
                error,
            });
            void this.scheduleReconnect(client);
        }
    }

    private reconnectPending = false;

    private async scheduleReconnect(oldClient: Client): Promise<void> {
        if (this.stopped) return;
        await oldClient.end().catch(() => undefined);
        if (this.client === oldClient) this.client = null;
        // A failing client can fire 'error' AND reject connect() for the
        // same failure — only one reconnect timer may be live at a time.
        if (this.reconnectPending) return;
        this.reconnectPending = true;
        const delay = this.reconnectDelayMs;
        // Capped exponential backoff: transient DB restarts recover fast,
        // a down DB doesn't get hammered.
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        setTimeout(() => {
            this.reconnectPending = false;
            void this.connect();
        }, delay).unref?.();
    }

    /**
     * Periodic metrics flush — logs one `[BRIDGE-METRIC]` line every 5s with
     * counters and timing percentiles for the previous window, then resets.
     * Uses console.log directly so it's greppable in `docker logs -f`
     * without any log-processor overhead.
     */
    private startMetricsLogger(): void {
        if (!this.isPrimary || this.metricsTimer) return;
        this.metricsTimer = setInterval(() => {
            const m = this.metrics;
            const pool = this.poolSnapshot();
            // Skip the line when the window is fully idle. A quiet
            // bridge is the common case (nights/weekends/warm-standby);
            // logging 17k zero-only lines per process per day burns
            // real CloudWatch $ for nothing. We still emit the line
            // whenever ANY counter moved or the pool is doing work.
            const anySignal =
                m.forwarded > 0 ||
                m.forwardErrors > 0 ||
                m.notifyReceived > 0 ||
                m.delivered > 0 ||
                m.deliverErrors > 0 ||
                m.deliverDropped > 0 ||
                m.envelopeMissing > 0 ||
                this.inflightDeliveries > 0 ||
                (pool.waiting ?? 0) > 0;
            if (!anySignal) {
                return;
            }
            const line = [
                `[BRIDGE-METRIC]`,
                `t=${new Date().toISOString()}`,
                `component=${process.env.COMPONENT_TYPE || 'unknown'}`,
                `pid=${process.pid}`,
                `fwd=${m.forwarded}`,
                `fwdErr=${m.forwardErrors}`,
                `insertMs=p50:${pctl(m.insertMs, 50)}/p95:${pctl(m.insertMs, 95)}/max:${max(m.insertMs)}`,
                `notifyMs=p50:${pctl(m.notifyMs, 50)}/p95:${pctl(m.notifyMs, 95)}/max:${max(m.notifyMs)}`,
                `notifyRecv=${m.notifyReceived}`,
                `delivered=${m.delivered}`,
                `delivErr=${m.deliverErrors}`,
                `delivDrop=${m.deliverDropped}`,
                `missing=${m.envelopeMissing}`,
                `selectMs=p50:${pctl(m.selectMs, 50)}/p95:${pctl(m.selectMs, 95)}/max:${max(m.selectMs)}`,
                `lagMs=p50:${pctl(m.lagMs, 50)}/p95:${pctl(m.lagMs, 95)}/max:${max(m.lagMs)}`,
                `inflight=${this.inflightDeliveries}`,
                `pool=total:${pool.total}/idle:${pool.idle}/waiting:${pool.waiting}`,
            ].join(' ');
            // eslint-disable-next-line no-console
            console.log(line);
            // Reset window (counters + histograms).
            this.metrics = {
                forwarded: 0,
                forwardErrors: 0,
                insertMs: [],
                notifyMs: [],
                notifyReceived: 0,
                delivered: 0,
                deliverErrors: 0,
                deliverDropped: 0,
                envelopeMissing: 0,
                selectMs: [],
                lagMs: [],
            };
        }, 5_000).unref?.();
    }

    /**
     * pg-pool exposes `totalCount/idleCount/waitingCount` as live getters
     * — waiting > 0 is the tell that the pool is saturated. Reports the
     * DEDICATED bridge pool now (was the main TypeORM pool before we
     * isolated the bridge on its own connection pool).
     */
    private poolSnapshot(): { total: number; idle: number; waiting: number } {
        try {
            const pool = this.bridgePool;
            return {
                total: pool?.totalCount ?? -1,
                idle: pool?.idleCount ?? -1,
                waiting: pool?.waitingCount ?? -1,
            };
        } catch {
            return { total: -1, idle: -1, waiting: -1 };
        }
    }
}

function pctl(arr: number[], p: number): number {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

function max(arr: number[]): number {
    if (!arr.length) return 0;
    let m = arr[0];
    for (let i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
}
