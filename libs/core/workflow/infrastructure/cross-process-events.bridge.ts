import { randomUUID } from 'node:crypto';

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Client } from 'pg';

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
        // Fire and forget: LISTEN connectivity must never block boot.
        void this.connect();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        await this.client?.end().catch(() => undefined);
        this.client = null;
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

        try {
            // NOTIFY payloads are capped at 8KB by Postgres, and
            // pull-request.closed carries the PR's file list (unbounded).
            // Store the envelope in a row and notify only the id, so
            // payload size can never silently drop an event.
            const rows = await this.dataSource.query(
                `INSERT INTO ${PG_TABLE} (envelope) VALUES ($1::jsonb) RETURNING id`,
                [serialized],
            );
            const id = rows?.[0]?.id;
            if (id === undefined || id === null) {
                throw new Error('insert returned no id');
            }
            await this.dataSource.query('SELECT pg_notify($1, $2)', [
                PG_CHANNEL,
                String(id),
            ]);
        } catch (error) {
            this.logger.warn({
                message: `Failed to forward ${name} across processes (local delivery unaffected)`,
                context: CrossProcessEventsBridge.name,
                error,
            });
        }
    }

    /**
     * Table + trigger-free schema, created idempotently at boot. Rows are
     * read by every OTHER process (multiple listeners), so reads never
     * delete; expired rows are swept opportunistically on connect.
     */
    private async ensureInfra(): Promise<void> {
        await this.dataSource.query(
            `CREATE TABLE IF NOT EXISTS ${PG_TABLE} (
                id bigserial PRIMARY KEY,
                envelope jsonb NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            )`,
        );
        await this.dataSource.query(
            `DELETE FROM ${PG_TABLE} WHERE created_at < now() - interval '${ROW_TTL_MINUTES} minutes'`,
        );
    }

    private async deliverById(rawId: string): Promise<void> {
        const id = Number(rawId);
        if (!Number.isFinite(id)) return;
        try {
            const rows = await this.dataSource.query(
                `SELECT envelope FROM ${PG_TABLE} WHERE id = $1`,
                [id],
            );
            const envelope = rows?.[0]?.envelope as BridgeEnvelope | undefined;
            if (this.shouldReemit(envelope)) {
                this.eventEmitter.emit(envelope!.name, {
                    ...envelope!.payload,
                    [BRIDGED_FLAG]: true,
                });
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to fetch cross-process event envelope — event skipped in this process',
                context: CrossProcessEventsBridge.name,
                error,
                metadata: { id },
            });
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
        const client = new Client(
            options.url
                ? {
                      connectionString: options.url,
                      ...(ssl !== undefined ? { ssl } : {}),
                  }
                : {
                      host: options.host,
                      port: options.port,
                      user: options.username,
                      password: options.password,
                      database: options.database,
                      ...(ssl !== undefined ? { ssl } : {}),
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
            void this.deliverById(msg.payload);
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
}
