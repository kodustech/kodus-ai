import type { BrowserExploreRequest, BrowserExploreResult } from '@libs/runtime/contracts/browser-exploration';
import type { BakeOutcome, BakeRequest, Blocked, Claim, Consumer, EnvError, ExecRequest, LeaseRenewal, ProbeOutcome, StepResult } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';
import { decodeFrame, Envelope, type EvidenceRequest, hubAccepts, type MachineSize, MessageBody, MessageType, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import type { RunStreamEvent, RunStreamStore } from '@libs/runtime/run';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { RuntimeLogger } from '../shared/observability/logger';
import type { KeyedRunStreamStore } from '../shared/persistence/pg-run-stream-store';
import { CaMaterial } from './ca/x509';
import { capabilitiesOfHello } from './cell-capabilities';
import { ClaimLeaseService } from './claims/claim-lease';
import { AcquireInput, claimIdFor, ClaimService } from './claims/claim.service';
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

// The hub side of the cell protocol (ADR-051, ADR-054), as one entry point
// over its parts: CellIdentityService (who a cell is), CellConnectionRegistry
// (the live sockets), ClaimService (the claim lifecycle) and StepDispatcher
// (steps on a bound claim). Every inbound frame goes through the strict
// decoder and is checked against cell → org and stepId → cell, claim, org.
// A frame that does not match gets a nack and counts in protocol.violation.

export { CELL_CERT_HOURS } from './enrollment/cell-identity.service';
export { CellUnavailableError, ClaimScopeError } from './hub-types';
export type { CellCredential, ClaimRef, HubLogLine, IssuedIdentity, PeerCert, SocketLike } from './hub-types';

const CELL_TO_HUB: ReadonlySet<MessageType> = new Set(['hello', 'heartbeat', 'claim.ready', 'claim.failed', 'claim.progress', 'step.result', 'step.stream', 'blocked', 'egress.blocked', 'ack', 'nack']);

export interface CellHubOptions {
    admission?: Pick<TicketServiceOptions, 'ownership' | 'directory' | 'ttlMs'>;
    replicaId: string;
    replicaUrl: string;
    /** The internal CA that signs the cells' short certificates. */
    ca: CaMaterial;
    /** isolation 'none' (local-docker) is refused unless this is set (RUNTIME_DEV_ALLOW_INSECURE_CELLS=1). */
    allowInsecureCells?: boolean;
    readyTimeoutMs?: number;
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
    readonly leases: ClaimLeaseService;
    readonly steps: StepDispatcher;
    readonly hubMetrics = new HubMetrics();
    /** Where each claim's preparation is (claim.progress), for the worker's setup view. */
    readonly progress = new ClaimProgressBook();
    private readonly log: HubLog;
    /** A replacement hello cannot let an older in-flight session write win last. */
    private readonly hellos = new Map<string, Promise<void>>();

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
        this.identity = new CellIdentityService(store, opts.ca, this.hubMetrics, this.log, now);
        this.claims = new ClaimService(store, this.connections, metrics, this.hubMetrics, this.log, { readyTimeoutMs: opts.readyTimeoutMs, now });
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
    register(token: string, topology: string, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        return this.identity.register(token, topology, csrPem);
    }
    renew(cred: CellCredential, csrPem: string): Promise<IssuedIdentity | { ok: false; reason: string }> {
        return this.identity.renew(cred, csrPem);
    }
    ensureManagedCells(cells: Record<string, string>, expiresAt: string): Promise<void> {
        return this.identity.ensureManagedCells(cells, expiresAt);
    }

    /** Drops the connections of revoked cells right away (ADR-054). */
    async enforceRevocations(): Promise<string[]> {
        const revoked = await this.identity.revokedAmong(this.connections.heldCellIds());
        for (const cellId of revoked) await this.connections.evict(cellId, 'revoked by an admin');
        return revoked;
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
        // Frames of one connection are handled in order: hello must be done before the next frame is read.
        let chain: Promise<void> = Promise.resolve();
        return {
            onMessage: (raw) =>
                (chain = chain
                    .then(() => this.onMessage(conn, raw))
                    .catch((e) => {
                        this.hubMetrics.backgroundError('frame');
                        this.log('error', 'cell.frame_failed', { cellId: cred.cellId, error: (e as Error).message });
                    })),
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
                await this.store.heartbeat(conn.cred.cellId, this.opts.replicaId, body.freeSlots,
                    conn.sessionEpoch,
                );
                if (conn.closed || !this.connections.isCurrent(conn)) return;
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

    private onHello(conn: CellConnection, msg: Envelope<'hello'>): Promise<void> {
        const cellId = conn.cred.cellId;
        const previous = this.hellos.get(cellId) ?? Promise.resolve();
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
        if (!body.versions.includes(PROTOCOL_VERSION)) return this.connections.nack(conn, msg.id, 'unsupported_version', `hub speaks v${PROTOCOL_VERSION}`);
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
        // A new session: the cell's next heartbeat says what it holds.
        this.claims.memory.reset(conn.cred.cellId, conn.sessionEpoch);
        this.metrics.cellConnectedDelta(1, { owner: conn.cred.owner });
        this.log('info', 'cell.hello', {
            cellId: conn.cred.cellId,
            owner: conn.cred.owner,
            driver: body.driver,
            isolation: body.isolation,
            features: caps.features.join(','),
            ...(caps.maxClaimSize ? { maxClaimMemoryMb: caps.maxClaimSize.memoryMb, maxClaimCpus: caps.maxClaimSize.cpus } : {}),
        });
        // The optional fields this cell may send us; only names it offered, so an older cell never sees accepts.
        const accepts = hubAccepts(body.features);
        this.connections.ack(conn, msg.id, { version: PROTOCOL_VERSION, ...(accepts.length ? { accepts } : {}) });
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
        return this.claims.pushEgressPolicy(orgId, environmentId, allow);
    }
    bake(req: BakeRequest & { claimId: string }): Promise<BakeOutcome> {
        return this.claims.bake(req);
    }
    poolTarget(cellId: string, req: { organizationId: string; environmentId: string; imageId: string; size: number; machineSize?: MachineSize; claimId?: string }): Promise<BakeOutcome> {
        return this.claims.poolTarget(cellId, req);
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
    reset(ref: ClaimRef, imageId: string, stepId?: string): Promise<{ ok: true; durationMs?: number } | EnvError> {
        return this.steps.reset(ref, imageId, stepId);
    }
}
