import type { BrowserExploreRequest, BrowserExploreResult } from '@libs/runtime/contracts/browser-exploration';
import type { BakeOutcome, BakeRequest, Blocked, Claim, Consumer, EnvError, ExecRequest, LeaseRenewal, ProbeOutcome, StepResult } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';
import { cellProtocolOf, decodeFrame, Envelope, type EvidenceRequest, type ExercisedRequest, type ExercisedResult, helloVersionRefusal, HUB_CELL_PROTOCOLS, hubAccepts, type MachineSize, MessageBody, MessageType, MIN_CELL_PROTOCOL_VERSION, PROTOCOL_VERSION, SANDBOX_ENVIRONMENT_ID, SUPPORTED_VERSIONS, type SandboxOp, type SandboxResult, type SnapshotPurpose } from '@libs/runtime/protocol';
import type { RunStreamEvent, RunStreamStore } from '@libs/runtime/run';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { RuntimeLogger } from '../shared/observability/logger';
import type { KeyedRunStreamStore } from '@libs/runtime/run/adapters/pg-run-stream.store';
import { CaMaterial } from './ca/x509';
import { capabilitiesOfHello } from './cell-capabilities';
import { ClaimLeaseService } from './claims/claim-lease';
import { AcquireInput, claimIdFor, ClaimService } from './claims/claim.service';
import { ClaimImageService } from './claims/claim-image.service';
import { StepDispatcher } from './claims/step-dispatcher';
import { CellIdentityService } from './enrollment/cell-identity.service';
import { CellConnection, CellConnectionRegistry } from './gateway/cell-connections';
import type { CellSession, HubStore } from './hub-store';
import { CellCredential, ClaimRef, HubLog, HubLogLine, HubMetrics, IssuedIdentity, PeerCert, SocketLike } from './hub-types';
import { ClaimProgressBook, type ClaimProgressView } from './claims/claim-progress';
import {
    TicketService,
    type TicketServiceOptions,
} from './claims/ticket.service';
import type { MachineMinuteBudget } from './claims/machine-minutes';
import type { OrgSecretRefs } from './claims/org-secret-refs';
import { ClaimPreviewService, type PreviewRouteOutcome, type PreviewTicketSink } from './claims/claim-preview.service';

// The hub side of the cell protocol (ADR-051, ADR-054), as one entry point
// over its parts: CellIdentityService (who a cell is), CellConnectionRegistry
// (the live sockets), ClaimService (the claim lifecycle) and StepDispatcher
// (steps on a bound claim). Every inbound frame goes through the strict
// decoder and is checked against cell → org and stepId → cell, claim, org.
// A frame that does not match gets a nack and counts in protocol.violation.

/** How far past the hub's clock a cell may date an eviction (clock skew). */
const EVICTED_AT_SKEW_MS = 5 * 60_000;

export { CELL_CERT_HOURS } from './enrollment/cell-identity.service';
export { CellUnavailableError, ClaimScopeError } from './hub-types';
export type { CellCredential, ClaimRef, HubLogLine, IssuedIdentity, PeerCert, SocketLike } from './hub-types';

const CELL_TO_HUB: ReadonlySet<MessageType> = new Set(['hello', 'heartbeat', 'claim.ready', 'claim.failed', 'claim.progress', 'step.result', 'step.stream', 'blocked', 'egress.blocked', 'image.shared', 'ack', 'nack']);

/** A cell sends a heartbeat every 10 s: one that sent no frame for this long (four missed) is taken for gone. */
export const CELL_SILENCE_MS = 45_000;

export interface CellHubOptions {
    admission?: Pick<TicketServiceOptions, 'ownership' | 'directory' | 'ttlMs'>;
    replicaId: string;
    replicaUrl: string;
    /** The internal CA that signs the cells' short certificates. */
    ca: CaMaterial;
    /** isolation 'none' (local-docker) is refused unless this is set (RUNTIME_DEV_ALLOW_INSECURE_CELLS=1). */
    allowInsecureCells?: boolean;
    readyTimeoutMs?: number;
    /** The org's daily machine minutes (RUNTIME_MACHINE_MINUTES_PER_ORG_DAY), reserved per claim round before it reaches a cell; absent, nothing is counted. */
    machineMinutes?: MachineMinuteBudget;
    /** The org's secrets by reference (the product's runtime_secrets, RUNTIME_PRODUCT_SECRETS_READ_URL); absent, no claim gets any. */
    secrets?: OrgSecretRefs;
    /** What a sandbox that asks no size is admitted at on a cell whose hello names no sandboxSize (RUNTIME_SANDBOX_MEMORY_MB; default DEFAULT_SANDBOX_MEMORY_MB). */
    sandboxMemoryMb?: number;
    /** The preview edge's tunnel endpoint the hub sends cells (RUNTIME_PREVIEW_TUNNEL_URL) and where it records their tickets; absent, no preview is routed. */
    preview?: { tunnelUrl: string; tickets: PreviewTicketSink };
    /** How long a cell may send no frame before its session is ended (default CELL_SILENCE_MS). */
    cellSilenceMs?: number;
    /** Structured per-claim log lines (msg plus cellId, claimId, runId, stepId); never a token or a key. */
    log?: (line: HubLogLine) => void;
    /** Where the hub's own lines go when `log` is not given. */
    logger?: RuntimeLogger;
    now?: () => Date;
}

export class CellHub {
    readonly tickets?: TicketService;
    readonly identity: CellIdentityService;
    readonly connections: CellConnectionRegistry;
    readonly claims: ClaimService;
    /** Bakes and pool targets: never from a claim that ran PR code. */
    readonly images: ClaimImageService;
    readonly leases: ClaimLeaseService;
    readonly steps: StepDispatcher;
    /** Preview routes on preview claims (docs/runtime/preview-urls.md). */
    readonly previews: ClaimPreviewService;
    readonly hubMetrics = new HubMetrics();
    /** Where each claim's preparation is (claim.progress), for the worker's setup view. */
    readonly progress = new ClaimProgressBook();
    private readonly log: HubLog;
    /** A replacement hello cannot let an older in-flight session write win last. */
    private readonly hellos = new Map<string, Promise<void>>();
    private lastSilenceCheckAt?: number;

    constructor(
        private readonly store: HubStore,
        private readonly streams: RunStreamStore | KeyedRunStreamStore,
        private readonly metrics: RuntimeMetrics,
        private readonly opts: CellHubOptions,
    ) {
        const now = () => this.opts.now?.() ?? new Date();
        const logger = opts.logger ?? new RuntimeLogger('runtime-hub').child('CellHub');
        this.log = (level, msg, fields = {}) => {
            const line: HubLogLine = { level, msg, replicaId: opts.replicaId, ...fields };
            if (opts.log) return opts.log(line);
            const { level: _l, msg: _m, ...rest } = line;
            logger.write(level, msg, rest);
        };
        this.connections = new CellConnectionRegistry(store, metrics, this.hubMetrics, opts.replicaId, this.log);
        this.hubMetrics.observeCells(() => this.connections.views(), () => now().getTime());
        this.identity = new CellIdentityService(store, opts.ca, this.hubMetrics, this.log, now);
        this.claims = new ClaimService(store, this.connections, metrics, this.hubMetrics, this.log, { readyTimeoutMs: opts.readyTimeoutMs, now, machineMinutes: opts.machineMinutes, secrets: opts.secrets, sandboxMemoryMb: opts.sandboxMemoryMb });
        this.images = new ClaimImageService(store, this.connections, metrics, now);
        if (opts.admission) {
            this.tickets = new TicketService(
                this.claims.memory,
                this.connections,
                store,
                {
                    ...opts.admission,
                    replicaId: opts.replicaId,
                    now: () => now().getTime(),
                    releaseClaim: (ref) => this.claims.release(ref),
                },
            );
            this.claims.tickets = this.tickets;
        }
        this.leases = new ClaimLeaseService(this.claims, store, this.connections, this.hubMetrics, this.log, now);
        this.previews = new ClaimPreviewService(this.claims, this.connections, opts.preview?.tickets, opts.preview?.tunnelUrl, this.log, now);
        this.steps = new StepDispatcher(
            this.claims,
            store,
            this.connections,
            (orgId, runId, event, key) => this.appendStepEvent(orgId, runId, event, now, key),
            metrics,
            this.hubMetrics,
            this.log,
            (cellId) => store.session(cellId),
        );
    }

    // ---- identity (ADR-054) ----

    handshakeAllowed(peer: PeerCert & { presented: boolean }): boolean {
        return this.identity.handshakeAllowed(peer);
    }
    refreshPins(): Promise<void> {
        return this.identity.reloadCertificatePins();
    }
    authenticateCell(peer: PeerCert): Promise<CellCredential | null> {
        return this.identity.authenticateCell(peer);
    }
    register(token: string, topology: string | undefined, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        return this.identity.register(token, topology, csrPem);
    }
    renew(cred: CellCredential, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        return this.identity.renew(cred, csrPem);
    }
    ensureManagedCells(cells: Record<string, string>, expiresAt: string): Promise<void> {
        return this.identity.ensureManagedCells(cells, expiresAt);
    }

    /**
     * Drops the connections of revoked cells right away (ADR-054), and of cells whose certificate expired
     * without a renewal (the cell dials again and is refused at the handshake). The cells dropped.
     */
    async enforceRevocations(): Promise<string[]> {
        const revoked = await this.identity.revokedAmong(this.connections.heldCellIds());
        for (const cellId of revoked) await this.connections.evict(cellId, 'revoked by an admin');
        const expired = await this.identity.expiredAmong(this.connections.heldCellIds());
        for (const cellId of expired) {
            const conn = this.connections.connection(cellId);
            if (!conn) continue;
            this.log('warn', 'cell.certificate_expired', { cellId });
            await this.connections.closed(conn);
        }
        return [...revoked, ...expired];
    }

    /**
     * Ends the sessions of cells that went silent: a path that dies without
     * closing the socket (a tunnel, a load balancer) leaves a connection the
     * hub would keep sending claims to, each lost at its ack. The session
     * ends as on a close (every wait on it resolves), and the cell, which
     * ends its own side after three unanswered heartbeats, dials again.
     * A check that itself ran late (the process was paused) drops nothing:
     * the frames that arrived meanwhile are not read yet.
     */
    async dropSilentCells(): Promise<string[]> {
        const silenceMs = this.opts.cellSilenceMs ?? CELL_SILENCE_MS;
        const now = (this.opts.now?.() ?? new Date()).getTime();
        const late = this.lastSilenceCheckAt !== undefined && now - this.lastSilenceCheckAt > silenceMs / 2;
        this.lastSilenceCheckAt = now;
        if (late) return [];
        const dropped: string[] = [];
        for (const conn of this.connections.silentSince(now - silenceMs)) {
            this.log('warn', 'cell.silent', { cellId: conn.cred.cellId, silentMs: now - conn.lastFrameAt });
            await this.connections.closed(conn);
            conn.socket.terminate?.();
            dropped.push(conn.cred.cellId);
        }
        return dropped;
    }

    // ---- connections and frames ----

    isConnected(cellId: string) {
        return this.connections.heldCellIds().includes(cellId);
    }

    sessionsHeld(): string[] {
        return this.connections.heldCellIds();
    }

    /** Where a claim's preparation is, for its own org (GET /internal/claims/:id/progress). */
    claimProgress(claimId: string, orgId: string): ClaimProgressView | null {
        return this.progress.get(claimId, orgId);
    }

    session(cellId: string): Promise<CellSession | null> {
        return this.store.session(cellId);
    }

    attach(socket: SocketLike, cred: CellCredential): { onMessage: (raw: string | Buffer) => Promise<void>; onClose: () => Promise<void> } {
        const conn = this.connections.add(socket, cred);
        const arrived = () => void (conn.lastFrameAt = (this.opts.now?.() ?? new Date()).getTime());
        arrived();
        // Frames of one connection are handled in order: hello must be done before the next frame is read.
        // The queue is bounded (CELL_INBOUND_LIMITS): reading pauses while it is deep, and a cell that floods past it is dropped.
        let chain: Promise<void> = Promise.resolve();
        return {
            onMessage: (raw) => {
                arrived();
                const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
                if (!this.connections.admitInbound(conn, bytes)) return chain;
                return (chain = chain
                    .then(() => this.onMessage(conn, raw))
                    .catch((e) => {
                        this.hubMetrics.backgroundError('frame');
                        this.log('error', 'cell.frame_failed', { cellId: cred.cellId, error: (e as Error).message });
                    })
                    .finally(() => this.connections.inboundHandled(conn, bytes)));
            },
            onClose: () => (chain = chain.then(() => this.connections.closed(conn))),
        };
    }

    private async onMessage(conn: CellConnection, raw: string | Buffer): Promise<void> {
        if (conn.closed || !this.connections.isCurrent(conn)) return;
        const decoded = decodeFrame(raw);
        if ('code' in decoded) return this.connections.nack(conn, undefined, decoded.code, decoded.message);
        const msg = decoded.message;

        if (msg.cellId !== conn.cred.cellId) return this.connections.nack(conn, msg.id, 'wrong_cell', 'cellId does not match the connection');
        if (!CELL_TO_HUB.has(msg.type)) return this.connections.nack(conn, msg.id, 'wrong_direction', `${msg.type} is sent by the hub`);
        if (!conn.helloDone && msg.type !== 'hello') return this.connections.nack(conn, msg.id, 'hello_first', 'the first message must be hello');

        switch (msg.type) {
            case 'hello':
                return this.onHello(conn, msg as Envelope<'hello'>);
            case 'heartbeat': {
                const body = msg.body as MessageBody<'heartbeat'>;
                conn.freeSlots = body.freeSlots;
                await this.store.heartbeat(conn.cred.cellId, this.opts.replicaId, body.freeSlots,
                    conn.sessionEpoch,
                );
                if (conn.closed || !this.connections.isCurrent(conn)) return;
                await this.syncEvictedBuildStates(conn, body);
                // Only a cell whose hello this hub accepted hostHardening from sends it.
                if (body.host) this.reportHost(conn, body.host);
                // Only a cell whose hello this hub accepted cellMemory from sends it (ADR-070).
                this.claims.memory.report(conn.cred.cellId, body.memory, body.claims.map((c) => c.claimId), (this.opts.now?.() ?? new Date()).getTime(),
                    body.freeSlots,
                    conn.sessionEpoch,
                );
                this.connections.ack(conn, msg.id);
                await this.claims.reconcile(conn, body.claims);
                return;
            }
            case 'claim.ready':
            case 'claim.failed':
                return this.claims.onOutcome(conn, msg as Envelope<'claim.ready'> | Envelope<'claim.failed'>);
            case 'blocked':
                // Unsolicited (claimId, no re): a security violation on one of the cell's claims.
                if (!msg.re) {
                    const claim = await this.claims.onUnsolicitedBlocked(conn, msg as Envelope<'blocked'>);
                    if (claim) {
                        const body = msg.body as MessageBody<'blocked'>;
                        // Keyed like the blocker row (once per claim, kind and signature): a cell that reports it again adds nothing.
                        await this.appendStepEvent(
                            claim.orgId,
                            claim.runId,
                            { type: 'security', data: { kind: 'exfiltration', side: claim.side, signature: body.signature } },
                            () => this.opts.now?.() ?? new Date(),
                            `security:${claim.claimId}:${body.signature}`,
                        );
                    }
                    return;
                }
                if (!this.connections.answer(conn, msg.re, msg)) return this.connections.nack(conn, msg.id, 'unknown_correlation', 're does not match a request on this connection');
                return;
            case 'ack':
            case 'nack':
                // A step frame is answered before its step.result: an ack admits it, a nack ends it.
                if (this.steps.onStepReply(conn, msg as Envelope<'ack'> | Envelope<'nack'>)) return;
                if (!this.connections.answer(conn, msg.re, msg)) return this.connections.nack(conn, msg.id, 'unknown_correlation', 're does not match a request on this connection');
                return;
            case 'step.result':
            case 'step.stream':
                return this.steps.onStepFrame(conn, msg as Envelope<'step.result'> | Envelope<'step.stream'>);
            case 'claim.progress': {
                const claim = msg.claimId ? await this.store.claim(msg.claimId) : null;
                if (!claim || claim.cellId !== conn.cred.cellId) return this.connections.nack(conn, msg.id, 'unknown_claim', 'claim is not held by this cell');
                this.progress.record(claim.claimId, claim.orgId, msg.body as MessageBody<'claim.progress'>, this.opts.now?.() ?? new Date());
                this.connections.ack(conn, msg.id);
                return;
            }
            case 'image.shared': {
                const body = msg.body as MessageBody<'image.shared'>;
                const refused = await this.images.recordShared({ cellId: conn.cred.cellId, owner: conn.cred.owner, orgId: conn.cred.orgId, features: conn.features }, body);
                const fields = { cellId: conn.cred.cellId, orgId: body.orgId, environmentId: body.environmentId, sha: body.sha, images: body.images.length };
                if (refused) {
                    this.log('warn', 'image.shared.refused', { ...fields, code: refused.code });
                    return this.connections.nack(conn, msg.id, refused.code, refused.message);
                }
                this.log('info', 'image.shared', fields);
                this.connections.ack(conn, msg.id);
                return;
            }
            case 'egress.blocked': {
                const body = msg.body as MessageBody<'egress.blocked'>;
                const claim = msg.claimId ? await this.store.claim(msg.claimId) : null;
                if (!claim || claim.cellId !== conn.cred.cellId) return this.connections.nack(conn, msg.id, 'unknown_claim', 'claim is not held by this cell');
                await this.store.insertEgress({ claimId: claim.claimId, cellId: conn.cred.cellId, orgId: claim.orgId, host: body.host, port: body.port, phase: body.phase, at: body.at });
                // The host stays in the events table: as a metric label it would be unbounded.
                this.metrics.recordEgressBlocked({ cellId: conn.cred.cellId, orgId: claim.orgId, phase: body.phase });
                this.connections.ack(conn, msg.id);
                return;
            }
        }
    }

    /** The last host report of each connection (heartbeat host), to log only a change. */
    private readonly hosts = new WeakMap<CellConnection, string>();

    /**
     * A microVM cell's host (SMT, KSM, swap, unmitigated CPU vulnerabilities, microcode, its policy), logged when it
     * changes. A Kodus-owned cell mixes orgs on its host: one that reports a dedicated policy with any of them on is an
     * alarm, since a shared cell refuses that host at start.
     */
    private reportHost(conn: CellConnection, host: NonNullable<MessageBody<'heartbeat'>['host']>): void {
        const key = JSON.stringify(host);
        if (this.hosts.get(conn) === key) return;
        this.hosts.set(conn, key);
        const unsafe = host.smt !== 'off' || host.ksm !== 'off' || host.swap !== 'off' || host.vulnerable.length > 0;
        const shared = conn.cred.owner === 'kodus' && host.policy === 'dedicated' && unsafe;
        this.log(shared ? 'warn' : 'info', shared ? 'cell.host.unsafe_shared' : 'cell.host', { cellId: conn.cred.cellId, owner: conn.cred.owner, ...host, ...(shared ? { alarm: true } : {}) });
    }

    private onHello(conn: CellConnection, msg: Envelope<'hello'>): Promise<void> {
        const cellId = conn.cred.cellId;
        const previous = this.hellos.get(cellId) ?? Promise.resolve();
        // Hellos of one cell run in order; the previous hello's failure already went back to its own caller.
        const pending = previous.catch(() => undefined).then(async () => {
            if (conn.closed || !this.connections.isCurrent(conn)) return;
            await this.acceptHello(conn, msg);
        });
        this.hellos.set(cellId, pending);
        const settled = () => { if (this.hellos.get(cellId) === pending) this.hellos.delete(cellId); };
        void pending.then(settled, settled);
        return pending;
    }

    private async acceptHello(conn: CellConnection, msg: Envelope<'hello'>) {
        if (conn.helloDone) return this.connections.nack(conn, msg.id, 'hello_repeated', 'hello was already done on this connection');
        const body = msg.body;
        // The skew policy (envelope.ts): a cell never newer than this hub, never older than MIN_CELL_PROTOCOL_VERSION.
        const refused = helloVersionRefusal(body.versions);
        if (refused) {
            this.log('warn', 'cell.refused_version', { cellId: conn.cred.cellId, code: refused.code, cellProtocol: cellProtocolOf(body.versions), hubProtocol: PROTOCOL_VERSION, minCellProtocol: MIN_CELL_PROTOCOL_VERSION });
            // In the hello's own version: the one a cell of any version reads.
            return this.connections.nack(conn, msg.id, refused.code, refused.message, msg.v);
        }
        const version = cellProtocolOf(body.versions);
        // A hello framed in a version other than one this hub decodes (its versions say otherwise): refused as any such frame.
        if (!SUPPORTED_VERSIONS.includes(msg.v)) return this.connections.nack(conn, msg.id, 'unsupported_version', `hello framed in v${msg.v}; this hub decodes ${SUPPORTED_VERSIONS.map((v) => `v${v}`).join(', ')}`, msg.v);
        if (body.owner !== conn.cred.owner) return this.connections.nack(conn, msg.id, 'wrong_owner', 'owner differs from the registration');
        if (body.isolation === 'none') {
            if (!this.opts.allowInsecureCells) return this.connections.nack(conn, msg.id, 'insecure_isolation', "isolation 'none' needs RUNTIME_DEV_ALLOW_INSECURE_CELLS=1 on the hub");
            this.log('warn', 'cell.insecure_isolation', {
                cellId: conn.cred.cellId,
                driver: body.driver,
                note: "isolation 'none' allowed only because RUNTIME_DEV_ALLOW_INSECURE_CELLS=1. Never in production.",
            });
        }
        // What the claims sent to this cell may carry (cell-capabilities.ts).
        const caps = capabilitiesOfHello(body);
        await this.store.upsertSession({
            cellId: conn.cred.cellId,
            sessionEpoch: conn.sessionEpoch,
            isolation: body.isolation,
            replicaId: this.opts.replicaId,
            replicaUrl: this.opts.replicaUrl,
            owner: conn.cred.owner,
            orgId: conn.cred.orgId ?? null,
            driver: body.driver,
            ...caps,
        });
        if (conn.closed || !this.connections.isCurrent(conn)) return;
        conn.helloDone = true;
        conn.version = version;
        conn.isolation = body.isolation;
        conn.driver = body.driver;
        conn.features = caps.features;
        // A new session: the cell's next heartbeat says what it holds.
        this.claims.memory.reset(conn.cred.cellId, conn.sessionEpoch);
        this.metrics.cellConnectedDelta(1, { owner: conn.cred.owner });
        this.log('info', 'cell.hello', {
            cellId: conn.cred.cellId,
            owner: conn.cred.owner,
            protocol: version,
            driver: body.driver,
            isolation: body.isolation,
            features: caps.features.join(','),
            ...(caps.maxClaimSize ? { maxClaimMemoryMb: caps.maxClaimSize.memoryMb, maxClaimCpus: caps.maxClaimSize.cpus } : {}),
            ...(caps.sandboxClaimSize ? { sandboxMemoryMb: caps.sandboxClaimSize.memoryMb, sandboxCpus: caps.sandboxClaimSize.cpus } : {}),
            // What its machines can be (hello capabilities); placement reads isolation alone.
            ...(body.capabilities
                ? {
                      backends: body.capabilities.backends.join(','),
                      snapshotMemory: body.capabilities.snapshotMemory,
                      nestedDocker: body.capabilities.nestedDocker,
                      kvm: body.capabilities.kvm,
                      arch: body.capabilities.arch,
                  }
                : {}),
        });
        // The optional fields this cell may send us; only names it offered, so an older cell never sees accepts.
        const accepts = hubAccepts(body.features);
        // cellProtocols only to a cell that named it: an older cell's strict decoder refuses the field.
        const cellProtocols = body.features?.includes('cellProtocols') ? { cellProtocols: { ...HUB_CELL_PROTOCOLS } } : {};
        this.connections.ack(conn, msg.id, { version, ...(accepts.length ? { accepts } : {}), ...cellProtocols });
    }

    /**
     * heartbeat evictedBuildStates: the environments whose build state this
     * cell's disk floor removed and no setup made again (the API shows them
     * as needing a setup again). From a cell that named buildStateEvicted the
     * list is its whole ledger, absent meaning none; written only when it
     * changed. A cell that did not name it says nothing, and nothing changes.
     * A customer's cell speaks only for its own org, and no cell dates an
     * eviction in the future (past a little clock skew): either would let
     * one cell push another org's real rows out of the readers' top 16, or
     * show a hint that is not true (review 2026-11-14, #10).
     */
    private async syncEvictedBuildStates(conn: CellConnection, body: MessageBody<'heartbeat'>): Promise<void> {
        if (!conn.features.includes('buildStateEvicted')) return;
        const latest = (this.opts.now?.() ?? new Date()).getTime() + EVICTED_AT_SKEW_MS;
        const named = body.evictedBuildStates ?? [];
        const rows = named
            .filter((e) => (conn.cred.owner !== 'customer' || e.orgId === conn.cred.orgId) && Date.parse(e.evictedAt) <= latest)
            .map((e) => ({ orgId: e.orgId, environmentId: e.environmentId, evictedAt: e.evictedAt, ...(e.rebuildSeconds ? { rebuildSeconds: e.rebuildSeconds } : {}) }));
        if (rows.length !== named.length) this.log('warn', 'cell.build_states_evicted.refused', { cellId: conn.cred.cellId, refused: named.length - rows.length });
        const key = JSON.stringify(rows);
        if (conn.evictedBuildStates === key) return;
        try {
            await this.store.syncEvictedBuildStates(conn.cred.cellId, rows);
            conn.evictedBuildStates = key;
            if (rows.length) this.log('info', 'cell.build_states_evicted', { cellId: conn.cred.cellId, environments: rows.length });
        } catch (e) {
            this.hubMetrics.backgroundError('build_state_evictions');
            this.log('warn', 'cell.build_states_evicted.unsaved', { cellId: conn.cred.cellId, error: (e as Error).message });
        }
    }

    // ---- Run stream ----

    /** A hub event of a Run; `key` makes it once-only in a keyed store (Postgres), whichever replica writes it. */
    private async appendStepEvent(orgId: string, runId: string | null | undefined, event: Omit<RunStreamEvent, 'at'>, now: () => Date, key?: string) {
        if (!runId) return;
        await (this.streams as KeyedRunStreamStore).append(orgId, runId, { ...event, at: now().toISOString() }, key).catch((e) => {
            this.hubMetrics.backgroundError('stream_append');
            this.log('warn', 'stream.append_failed', { runId, error: (e as Error).message });
        });
    }

    /** A Run event from the worker; `key` makes a retried append a no-op where the store supports it. */
    async appendRunEvent(orgId: string, runId: string, event: RunStreamEvent, key?: string) {
        await (this.streams as KeyedRunStreamStore).append(orgId, runId, event, key);
    }

    // ---- claims and steps ----

    async acquire(cellId: string, req: AcquireInput): Promise<Claim | Blocked> {
        const out = await this.claims.acquire(cellId, req);
        if ('capacity' in out && out.capacity) {
            // Waiting for room (ADR-070): the claim's progress says so, for the setup's live view.
            const at = this.opts.now?.() ?? new Date();
            this.progress.record(claimIdFor(req.organizationId, req.idempotencyKey), req.organizationId, { phase: 'capacity', state: 'started', at: at.toISOString(), lines: out.blockers.map((b) => b.message.slice(0, 2_048)) }, at);
        }
        return out;
    }
    release(ref: ClaimRef): Promise<void> {
        return this.claims.release(ref);
    }
    /** claim.renew for a claim its Run still uses (not the cell certificate's renew above). */
    renewLease(ref: ClaimRef, consumer: Consumer): Promise<LeaseRenewal> {
        return this.leases.renew(ref, consumer);
    }
    pushEgressPolicy(orgId: string, environmentId: string, allow: string[]): Promise<string[]> {
        return this.claims.egress.pushEgressPolicy(orgId, environmentId, allow);
    }
    bake(req: BakeRequest & { claimId: string }): Promise<BakeOutcome> {
        return this.images.bake(req);
    }
    poolTarget(cellId: string, req: { organizationId: string; environmentId: string; imageId: string; size: number; machineSize?: MachineSize; claimId?: string }): Promise<BakeOutcome> {
        return this.images.poolTarget(cellId, req);
    }
    /** snapshot.forget: an org's sessions on the cell, removed now (their PR closed). */
    forgetSessions(cellId: string, req: { organizationId: string; snapshotIds: string[] }) {
        return this.images.forgetSessions(cellId, req);
    }
    /** An environment removed: the records of its shared baked images go (docs/runtime/shared-baked-environments.md §8). */
    forgetSharedImages(organizationId: string, environmentId: string): Promise<number> {
        return this.images.forgetSharedImages(organizationId, environmentId);
    }
    probe(ref: ClaimRef, probe: Probe, stepId?: string, evidence?: EvidenceRequest): Promise<ProbeOutcome | EnvError> {
        return this.steps.probe(ref, probe, stepId, evidence);
    }
    exploreBrowser(ref: ClaimRef, request: BrowserExploreRequest, stepId: string): Promise<BrowserExploreResult | EnvError> {
        return this.steps.exploreBrowser(ref, request, stepId);
    }
    exec(ref: ClaimRef, req: ExecRequest): Promise<StepResult | EnvError> {
        return this.steps.exec(ref, req);
    }
    /** A code sandbox on the cell (sandbox.acquire): one tool machine, no repository, no Run. */
    acquireSandbox(
        cellId: string,
        req: { organizationId: string; idempotencyKey: string; egressAllow?: string[]; size?: MachineSize; secrets?: boolean; prepares?: boolean; templateKey?: string; resumeFrom?: string },
    ): Promise<Claim | Blocked> {
        return this.acquire(cellId, {
            organizationId: req.organizationId,
            environmentId: SANDBOX_ENVIRONMENT_ID,
            imageId: 'sandbox',
            ref: { side: 'pr', sha: '0'.repeat(40) },
            consumer: 'sandbox',
            idempotencyKey: req.idempotencyKey,
            expose: [],
            ...(req.egressAllow?.length ? { sandboxEgress: req.egressAllow } : {}),
            ...(req.size ? { size: req.size } : {}),
            ...(req.secrets ? { sandboxSecrets: true } : {}),
            ...(req.prepares || req.templateKey || req.resumeFrom
                ? { sandboxSnapshot: { ...(req.prepares ? { prepares: true } : {}), ...(req.templateKey ? { templateKey: req.templateKey } : {}), ...(req.resumeFrom ? { resumeFrom: req.resumeFrom } : {}) } }
                : {}),
        });
    }
    /** claim.exercised: the PR claim's changed lines its services ran; undefined when the cell does not name exercisedLines. */
    exercised(ref: ClaimRef, stepId: string, request: ExercisedRequest): Promise<ExercisedResult | undefined | EnvError> {
        return this.steps.exercised(ref, stepId, request);
    }

    /** claim.snapshot: the claim's workload kept as a memory snapshot (template, session or round). */
    snapshot(ref: ClaimRef, stepId: string, purpose: SnapshotPurpose): Promise<{ id: string; purpose: SnapshotPurpose; ms: number; cellId: string } | EnvError> {
        return this.steps.snapshot(ref, stepId, purpose);
    }
    sandboxOp(ref: ClaimRef, stepId: string, op: SandboxOp): Promise<SandboxResult | EnvError> {
        return this.steps.sandboxOp(ref, stepId, op);
    }
    /** preview.tunnel and preview.route to a preview claim's cell. */
    previewRoute(ref: ClaimRef, body: { previewId: string; target: { service: string; port: number }; until: string }): Promise<PreviewRouteOutcome> {
        return this.previews.route(ref, body);
    }
    previewUnroute(ref: ClaimRef, previewId: string): Promise<void> {
        return this.previews.unroute(ref, previewId);
    }
    /** upload: files into the claim's checkout (the protocol's upload frame). */
    upload(ref: ClaimRef, req: MessageBody<'upload'>): Promise<{ ok: true } | EnvError> {
        return this.steps.upload(ref, req);
    }
    reset(ref: ClaimRef, imageId: string, stepId?: string, roundSnapshotId?: string, timeoutMs?: number): Promise<{ ok: true; durationMs?: number } | EnvError> {
        return this.steps.reset(ref, imageId, stepId, roundSnapshotId, timeoutMs);
    }
}
