import type { Pool, PoolClient } from 'pg';

import { CellTokenLedger, InMemoryCellTokenStore, type RedeemResult } from '@libs/runtime/api/domain/cell-token';
import type { Consumer } from '@libs/runtime/environment';
import { knownCellFeatures } from '@libs/runtime/protocol';

import { reserveCellRow } from '../shared/cell-directory';
import { PgCommandStore } from '../shared/pg-command-store';
import type { CellCapabilities } from './cell-capabilities';

// What the hub keeps in the Runtime Postgres (docs §1b, §8): which replica
// holds each cell, the claims, the stepId → cell, claim, org index and the
// egress events. Shared between replicas. The hub is the only writer of
// runtime_claims; every claim state change names the states it may leave
// (compare-and-set), so a late writer can never resurrect or kill a claim.

/**
 * A cell's live session. The capabilities are what its hello said it may be
 * asked (cell-capabilities.ts); absent, it named none (an older cell).
 */
export interface CellSession extends Partial<CellCapabilities> {
    sessionEpoch?: string;
    isolation?: string;
    cellId: string;
    replicaId: string;
    replicaUrl: string;
    owner: 'kodus' | 'customer';
    orgId?: string | null;
    driver: string;
}

export const CLAIM_STATES = ['pending', 'bound', 'held', 'blocked', 'failed', 'compromised', 'released', 'terminated'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];
/** A claim that holds (or is about to hold) machines on a cell. */
export const LIVE_CLAIM_STATES: readonly ClaimState[] = ['pending', 'bound', 'held'];
/**
 * Every state but the two final ones. `compromised`: the cell reported a
 * security violation on the claim; it takes no step, its machines stay as
 * evidence until the claim is released.
 */
export const OPEN_CLAIM_STATES: readonly ClaimState[] = ['pending', 'bound', 'held', 'blocked', 'failed', 'compromised'];
export const isFinalClaimState = (s: ClaimState) => s === 'released' || s === 'terminated';

/**
 * Why a claim is in its state: a closed set that code, dashboards and alerts
 * match on, never free text. The cell's own code for the cause (a blocker
 * signature, a nack code) goes in ClaimCause.detail.
 */
export const CLAIM_REASONS = [
    /** pending: a claim.acquire was sent. */
    'acquired',
    /** pending: a new acquire round for a claim that was lost, failed or on another cell. */
    'reacquired',
    /** bound: the cell reported claim.ready. */
    'ready',
    /** held: the boot failed and the cell kept the machines for diagnosis. */
    'held_for_diagnosis',
    /** failed: the cell never answered the claim.acquire. */
    'acquire_unanswered',
    /** blocked: the cell refused the claim.acquire (detail: its nack code). */
    'cell_refused',
    /** blocked: the cell answered the claim.acquire with a blocker (detail: its signature). */
    'cell_blocked',
    /** failed: the cell accepted the claim and never reported it ready. */
    'not_ready',
    /** failed: the cell reported claim.failed (detail: kind/signature). */
    'boot_failed',
    /** compromised: the cell reported a security violation (detail: its signature). */
    'security_violation',
    /** released: the claim's owner released it. */
    'released',
    /** terminated: the cell was revoked with the claim still open. */
    'cell_revoked',
] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** What moved a claim: the reason, and the cell's code for it when there is one. */
export interface ClaimCause {
    reason: ClaimReason;
    detail?: string;
}

export interface ClaimRow {
    claimId: string;
    cellId: string;
    orgId: string;
    environmentId?: string | null;
    runId?: string | null;
    side: string;
    state: ClaimState;
    hardExpiresAt: string;
    /** The consumer the claim was acquired for: its lease TTL on every renew (null on rows from before migration 7). */
    consumer?: Consumer | null;
    /** The lease the last claim.acquire carried (a retry on the same cell reuses it, claim-deadlines.ts). */
    leaseExpiresAt?: string;
    /** Why the claim is in its state, and since when (null on rows from before migration 4). */
    reason?: ClaimReason | null;
    reasonDetail?: string | null;
    stateChangedAt?: string | null;
    /** What the round held, for the Run's cost (null on rows from before migration 11). */
    metering?: ClaimMetering | null;
    /** When this round was admitted (recorded), when the cell reported it ready, when it ended; null until then. */
    admittedAt?: string | null;
    readyAt?: string | null;
    releasedAt?: string | null;
}

/**
 * What one acquire round of a claim holds, recorded once when the hub admits
 * it (migration 11), so the API prices a Run by what its claims held: the
 * cell's driver, and on a cell whose claims share its memory (ADR-070) the
 * MB the hub counts the claim for while it boots and once ready, and what
 * the cell may commit to claims in all. The memory is null on a cell that
 * reports none (an aws-ec2 cell, one VM per claim; an older cell).
 */
export interface ClaimMetering {
    driver: string;
    bootMb: number | null;
    readyMb: number | null;
    allocatableMb: number | null;
}

export interface StepRow {
    stepId: string;
    cellId: string;
    claimId: string;
    orgId: string;
    runId?: string | null;
    commandHash: string;
}

export interface RegisteredCell {
    cellId: string;
    organizationId: string | null;
    owner: 'kodus' | 'customer';
    topology: string;
    status: string;
    /** Serial of the newest certificate, normalized hex. Older serials are refused. */
    certificateSerial: string;
    certificateExpiresAt: string;
}

export interface CellSessionRepository {
    /** Records the session on this replica and marks the cell connected (one statement). */
    upsertSession(s: CellSession): Promise<void>;
    heartbeat(cellId: string, replicaId: string, freeSlots: number,
        sessionEpoch?: string,
    ): Promise<void>;
    /** Ends the session only if this replica still holds it; the cell row follows only then. */
    disconnect(cellId: string, replicaId: string,
        sessionEpoch?: string): Promise<void>;
    /**
     * A connected cell that may serve this org (its own cells, or a managed
     * one, ADR-054), with one slot taken from its last reported free slots so
     * concurrent acquires spread out, and the org's claims spread over the
     * cells where it holds fewer. The next heartbeat restores the truth.
     * Falls back to the best cell with no free slot (the cell then refuses).
     * Uncapped: the worker's PgCellDirectory applies the org cap and answers
     * no_capacity instead of a full cell.
     */
    reserveCell(orgId: string): Promise<CellSession | null>;
    session(cellId: string): Promise<CellSession | null>;
}

export interface ClaimRepository {
    /** false when the claim already exists. */
    insertClaim(c: ClaimRow & { leaseExpiresAt: string }): Promise<boolean>;
    claim(claimId: string): Promise<ClaimRow | null>;
    /** Moves the claim to `to` only when its current state is one of `from`; true when it moved. */
    transitionClaim(claimId: string, from: readonly ClaimState[], to: ClaimState, cause: ClaimCause): Promise<boolean>;
    /** A new acquire round: the claim (any open state) belongs to cellId, pending again, admitted now with this round's metering. */
    rebindClaim(claimId: string, c: { cellId: string; leaseExpiresAt: string; hardExpiresAt: string; metering?: ClaimMetering | null }): Promise<boolean>;
    /**
     * The lease the cell acked for a claim.renew: moves forward only (never
     * back, never past hard_expires_at) and only while the claim is in one of
     * `states`; true when it moved.
     */
    renewClaimLease(claimId: string, leaseExpiresAt: string, states: readonly ClaimState[]): Promise<boolean>;
    /** Bound claims of an environment (where an approved egress host goes). */
    liveClaimsOfEnvironment(orgId: string, environmentId: string): Promise<ClaimRow[]>;
    /** Claims the hub believes live on a cell (heartbeat reconciliation). */
    liveClaimsOfCell(cellId: string): Promise<ClaimRow[]>;
}

/**
 * A blocker the cell reported on a claim, once per claim, kind and signature:
 * a security_violation, or why the claim failed to boot (claim.failed, or a
 * claim.acquire the cell answered blocked).
 */
export interface ClaimBlockerRow {
    claimId: string;
    orgId: string;
    runId?: string | null;
    cellId: string;
    side: string;
    kind: string;
    signature: string;
    /** The cell's reason, redacted; for a failed boot its error line (boot-failure.ts), at most 1,024 characters. */
    message: string;
    /** A failed boot's last output lines, redacted: at most 40, each at most 300 characters. */
    logTail?: string[];
    at: string;
}

export interface ClaimBlockerRepository {
    /** Idempotent: a resend of the same blocker records nothing new. */
    recordClaimBlocker(b: ClaimBlockerRow): Promise<void>;
    claimBlockers(claimIds: string[]): Promise<ClaimBlockerRow[]>;
}

export interface StepRepository {
    /** false when the stepId already exists with another command or claim (S-30). */
    insertStep(s: StepRow, opts?: { requireFresh?: boolean }): Promise<boolean>;
    step(stepId: string): Promise<StepRow | null>;
    finishStep(stepId: string): Promise<void>;
    insertEgress(e: { claimId: string; cellId: string; orgId: string; host: string; port: number; phase: string; at: string }): Promise<void>;
    /** The hosts approved for an environment (runtime_egress_approvals): a new claim gets them after claim.ready. */
    approvedHosts(orgId: string, environmentId: string): Promise<string[]>;
}

export interface CellRegistryRepository {
    /** A registered cell (ADR-054): its pinned certificate serial, owner, org and status. */
    registeredCell(cellId: string): Promise<RegisteredCell | null>;
    /**
     * Redeems a registration token and, when it is good, inserts the cell, in
     * one transaction: a database error never burns the token. A refused
     * token (expired, wrong topology) is still burned (single use).
     */
    redeemAndRegister(token: string, topology: string, cell: (redeemed: { organizationId: string; topology: string }) => RegisteredCell): Promise<RedeemResult>;
    /** Moves the pin to a renewed certificate; false when the cell is revoked or unknown. */
    pinCertificate(cellId: string, serial: string, expiresAt: string): Promise<boolean>;
    /**
     * A managed cell from config: creates its row, or re-pins it when the
     * configured serial changed since the last boot (a new dev-ca certificate).
     * Same serial as last boot: a pin the cell renewed since stays. Never un-revokes.
     */
    upsertManagedCell(c: { cellId: string; certificateSerial: string; certificateExpiresAt: string }): Promise<void>;
    cellPins(): Promise<Array<{ cellId: string; serial: string | null; status: string }>>;
    /** Of these cells, the ones revoked since they connected. */
    filterRevoked(cellIds: string[]): Promise<string[]>;
}

/** Everything the hub persists, one repository per aggregate. */
export interface HubStore extends CellSessionRepository, ClaimRepository, ClaimBlockerRepository, StepRepository, CellRegistryRepository {}

const isOpen = (s: ClaimState) => (OPEN_CLAIM_STATES as readonly string[]).includes(s);

export class InMemoryHubStore implements HubStore {
    readonly sessions = new Map<string, CellSession & { connected: boolean; lastHeartbeatAt: number; freeSlots: number }>();
    readonly claims = new Map<string, ClaimRow>();
    readonly steps = new Map<string, StepRow & { finished?: boolean }>();
    readonly egress: Array<{ claimId: string; cellId: string; orgId: string; host: string; port: number; phase: string; at: string }> = [];
    readonly cells = new Map<string, RegisteredCell>();
    readonly approvals = new Map<string, string[]>();
    readonly blockers: ClaimBlockerRow[] = [];
    private readonly managedSerials = new Map<string, string>();
    readonly ledger: CellTokenLedger;

    constructor(opts: { ledger?: CellTokenLedger } = {}) {
        this.ledger = opts.ledger ?? new CellTokenLedger(new InMemoryCellTokenStore());
    }

    async upsertSession(s: CellSession) {
        const prev = this.sessions.get(s.cellId);
        this.sessions.set(s.cellId, { ...s, connected: true, lastHeartbeatAt: Date.now(), freeSlots: prev?.freeSlots ?? 0 });
        const c = this.cells.get(s.cellId);
        if (c && c.status !== 'revoked') c.status = 'connected';
    }
    async heartbeat(cellId: string, replicaId: string, freeSlots: number,
        sessionEpoch?: string,
    ) {
        const s = this.sessions.get(cellId);
        if (s && s.replicaId === replicaId &&
            (!sessionEpoch || s.sessionEpoch === sessionEpoch)
        ) Object.assign(s, { lastHeartbeatAt: Date.now(), freeSlots });
    }
    async disconnect(cellId: string, replicaId: string, sessionEpoch?: string) {
        const s = this.sessions.get(cellId);
        if (!s || s.replicaId !== replicaId || !s.connected ||
            (sessionEpoch && s.sessionEpoch !== sessionEpoch)
        ) return;
        s.connected = false;
        const c = this.cells.get(cellId);
        if (c?.status === 'connected') c.status = 'disconnected';
    }
    async reserveCell(orgId: string) {
        const ok = [...this.sessions.values()].filter((s) => s.connected && (s.owner === 'kodus' || s.orgId === orgId));
        // As reserveCellRow: the org's own cells, then where the org holds fewer live claims, then the most free slots.
        const load = (cellId: string) => [...this.claims.values()].filter((c) => c.orgId === orgId && c.cellId === cellId && LIVE_CLAIM_STATES.includes(c.state)).length;
        const rank = (a: (typeof ok)[number], b: (typeof ok)[number]) =>
            (a.orgId === orgId ? -1 : 0) - (b.orgId === orgId ? -1 : 0) ||
            load(a.cellId) - load(b.cellId) ||
            b.freeSlots - a.freeSlots ||
            b.lastHeartbeatAt - a.lastHeartbeatAt;
        ok.sort(rank);
        const free = ok.find((s) => s.freeSlots > 0);
        if (free) free.freeSlots -= 1;
        return free ?? ok[0] ?? null;
    }
    async session(cellId: string) {
        const s = this.sessions.get(cellId);
        return s && s.connected ? s : null;
    }
    async insertClaim(c: ClaimRow & { leaseExpiresAt: string }) {
        if (this.claims.has(c.claimId)) return false;
        const now = new Date().toISOString();
        this.claims.set(c.claimId, { ...c, reason: 'acquired', reasonDetail: null, stateChangedAt: now, admittedAt: now, readyAt: null, releasedAt: null });
        return true;
    }
    async claim(claimId: string) {
        const c = this.claims.get(claimId);
        return c ? { ...c } : null;
    }
    async transitionClaim(claimId: string, from: readonly ClaimState[], to: ClaimState, cause: ClaimCause) {
        const c = this.claims.get(claimId);
        if (!c || !from.includes(c.state)) return false;
        const now = new Date().toISOString();
        Object.assign(c, {
            state: to,
            reason: cause.reason,
            reasonDetail: cause.detail ?? null,
            stateChangedAt: now,
            readyAt: cause.reason === 'ready' ? now : (c.readyAt ?? null),
            releasedAt: to === 'released' || to === 'terminated' ? now : (c.releasedAt ?? null),
        });
        return true;
    }
    async rebindClaim(claimId: string, n: { cellId: string; leaseExpiresAt: string; hardExpiresAt: string; metering?: ClaimMetering | null }) {
        const c = this.claims.get(claimId);
        if (!c || !isOpen(c.state)) return false;
        const now = new Date().toISOString();
        Object.assign(c, {
            cellId: n.cellId,
            state: 'pending' as const,
            leaseExpiresAt: n.leaseExpiresAt,
            hardExpiresAt: n.hardExpiresAt,
            reason: 'reacquired' as const,
            reasonDetail: null,
            stateChangedAt: now,
            metering: n.metering ?? null,
            admittedAt: now,
            readyAt: null,
            releasedAt: null,
        });
        return true;
    }
    async renewClaimLease(claimId: string, leaseExpiresAt: string, states: readonly ClaimState[]) {
        const c = this.claims.get(claimId);
        if (!c || !states.includes(c.state)) return false;
        const until = Math.min(Date.parse(leaseExpiresAt), Date.parse(c.hardExpiresAt));
        if (c.leaseExpiresAt && Date.parse(c.leaseExpiresAt) >= until) return false;
        c.leaseExpiresAt = new Date(until).toISOString();
        return true;
    }
    async liveClaimsOfEnvironment(orgId: string, environmentId: string) {
        return [...this.claims.values()].filter((c) => c.orgId === orgId && c.environmentId === environmentId && c.state === 'bound');
    }
    async liveClaimsOfCell(cellId: string) {
        return [...this.claims.values()].filter((c) => c.cellId === cellId && LIVE_CLAIM_STATES.includes(c.state));
    }
    async recordClaimBlocker(b: ClaimBlockerRow) {
        if (!this.blockers.some((x) => x.claimId === b.claimId && x.kind === b.kind && x.signature === b.signature)) this.blockers.push({ ...b });
    }
    async claimBlockers(claimIds: string[]) {
        return this.blockers.filter((b) => claimIds.includes(b.claimId)).map((b) => ({ ...b }));
    }
    async insertStep(s: StepRow, opts?: { requireFresh?: boolean }) {
        const prev = this.steps.get(s.stepId);
        if (prev) return !opts?.requireFresh && prev.commandHash === s.commandHash && prev.claimId === s.claimId;
        this.steps.set(s.stepId, s);
        return true;
    }
    async step(stepId: string) {
        return this.steps.get(stepId) ?? null;
    }
    async finishStep(stepId: string) {
        const s = this.steps.get(stepId);
        if (s) s.finished = true;
    }
    async insertEgress(e: { claimId: string; cellId: string; orgId: string; host: string; port: number; phase: string; at: string }) {
        this.egress.push(e);
    }
    async approvedHosts(orgId: string, environmentId: string) {
        return [...(this.approvals.get(`${orgId}/${environmentId}`) ?? [])].sort();
    }
    async registeredCell(cellId: string) {
        return this.cells.get(cellId) ?? null;
    }
    async redeemAndRegister(token: string, topology: string, cell: (r: { organizationId: string; topology: string }) => RegisteredCell) {
        const r = await this.ledger.redeem(token, topology);
        if (r.ok) {
            const row = cell(r);
            this.cells.set(row.cellId, row);
        }
        return r;
    }
    async filterRevoked(cellIds: string[]) {
        return cellIds.filter((id) => this.cells.get(id)?.status === 'revoked');
    }
    async pinCertificate(cellId: string, serial: string, expiresAt: string) {
        const c = this.cells.get(cellId);
        if (!c || c.status === 'revoked') return false;
        c.certificateSerial = serial;
        c.certificateExpiresAt = expiresAt;
        return true;
    }
    async upsertManagedCell(m: { cellId: string; certificateSerial: string; certificateExpiresAt: string }) {
        const c = this.cells.get(m.cellId);
        if (c?.status === 'revoked') return;
        const repin = !c || this.managedSerials.get(m.cellId) !== m.certificateSerial || c.certificateSerial === m.certificateSerial;
        this.managedSerials.set(m.cellId, m.certificateSerial);
        if (!repin) return;
        this.cells.set(m.cellId, { cellId: m.cellId, organizationId: null, owner: 'kodus', topology: 'managed', status: c?.status ?? 'disconnected', ...m });
    }
    async cellPins() {
        return [...this.cells.values()].map((c) => ({ cellId: c.cellId, serial: c.certificateSerial, status: c.status }));
    }
}

type Queryable = Pick<Pool, 'query'>;

/** The four metering columns of a claim row, null when the round recorded none. */
const meteringValues = (m: ClaimMetering | null | undefined) => [m?.driver ?? null, m?.bootMb ?? null, m?.readyMb ?? null, m?.allocatableMb ?? null];

export class PgHubStore implements HubStore {
    constructor(private readonly pool: Queryable & Partial<Pick<Pool, 'connect'>>) {}

    async upsertSession(s: CellSession) {
        await this.pool.query(
            `WITH s AS (
               INSERT INTO runtime.runtime_cell_sessions (cell_id, replica_id, replica_url, owner, org_id, driver, features, max_claim_memory_mb, max_claim_cpus, session_epoch, isolation,
                 connected_at, last_heartbeat_at, disconnected_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), NULL)
               ON CONFLICT (cell_id) DO UPDATE SET replica_id = EXCLUDED.replica_id, replica_url = EXCLUDED.replica_url, owner = EXCLUDED.owner,
                 org_id = EXCLUDED.org_id, driver = EXCLUDED.driver, features = EXCLUDED.features,
                 max_claim_memory_mb = EXCLUDED.max_claim_memory_mb, max_claim_cpus = EXCLUDED.max_claim_cpus,
                 session_epoch = EXCLUDED.session_epoch, isolation = EXCLUDED.isolation,
                 connected_at = now(), last_heartbeat_at = now(), disconnected_at = NULL
               RETURNING cell_id)
             UPDATE runtime.runtime_cells c SET status = 'connected', last_heartbeat_at = now() FROM s WHERE c.cell_id = s.cell_id AND c.status <> 'revoked'`,
            // Every hello rewrites the capabilities: a cell that reconnects downgraded loses what it no longer names.
            [s.cellId, s.replicaId, s.replicaUrl, s.owner, s.orgId ?? null, s.driver, [...(s.features ?? [])], s.maxClaimSize?.memoryMb ?? null, s.maxClaimSize?.cpus ?? null,
                s.sessionEpoch ?? null,
                s.isolation ?? null,
            ],
        );
    }
    async heartbeat(cellId: string, replicaId: string, freeSlots: number,
        sessionEpoch?: string,
    ) {
        await this.pool.query(
            `UPDATE runtime.runtime_cell_sessions SET last_heartbeat_at = now(), free_slots = $3 WHERE cell_id = $1 AND replica_id = $2 AND ($4::text IS NULL OR session_epoch::text = $4)`, [
            cellId,
            replicaId,
            freeSlots, sessionEpoch ?? null]);
    }
    async disconnect(cellId: string, replicaId: string, sessionEpoch?: string) {
        await this.pool.query(
            `WITH s AS (
               UPDATE runtime.runtime_cell_sessions SET disconnected_at = now()
                WHERE cell_id = $1 AND replica_id = $2 AND disconnected_at IS NULL AND ($3::text IS NULL OR session_epoch::text = $3) RETURNING cell_id)
             UPDATE runtime.runtime_cells c SET status = 'disconnected' FROM s WHERE c.cell_id = s.cell_id AND c.status = 'connected'`,
            [cellId, replicaId, sessionEpoch ?? null],
        );
    }
    private row(r: any): CellSession {
        return {
            cellId: r.cell_id,
            sessionEpoch: r.session_epoch ?? undefined,
            isolation: r.isolation ?? undefined,
            replicaId: r.replica_id,
            replicaUrl: r.replica_url,
            owner: r.owner,
            orgId: r.org_id,
            driver: r.driver,
            features: knownCellFeatures(r.features ?? []),
            maxClaimSize: r.max_claim_memory_mb != null && r.max_claim_cpus != null ? { memoryMb: r.max_claim_memory_mb, cpus: r.max_claim_cpus } : null,
        };
    }
    async reserveCell(orgId: string) {
        const r = await reserveCellRow(this.pool, orgId);
        return r ? this.row(r) : null;
    }
    async session(cellId: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_cell_sessions WHERE cell_id = $1 AND disconnected_at IS NULL`, [cellId]);
        return r.rows[0] ? this.row(r.rows[0]) : null;
    }
    async insertClaim(c: ClaimRow & { leaseExpiresAt: string }) {
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_claims (claim_id, cell_id, org_id, environment_id, run_id, side, state, lease_expires_at, hard_expires_at, consumer, reason, state_changed_at,
                                                 driver, memory_mb_boot, memory_mb_ready, memory_allocatable_mb, admitted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'acquired', now(), $11, $12, $13, $14, now()) ON CONFLICT (claim_id) DO NOTHING`,
            [
                c.claimId,
                c.cellId,
                c.orgId,
                c.environmentId ?? null,
                c.runId ?? null,
                c.side,
                c.state,
                c.leaseExpiresAt,
                c.hardExpiresAt,
                c.consumer ?? null,
                ...meteringValues(c.metering),
            ],
        );
        return r.rowCount === 1;
    }
    async claim(claimId: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_claims WHERE claim_id = $1`, [claimId]);
        return r.rows[0] ? this.claimRow(r.rows[0]) : null;
    }
    private claimRow(x: any): ClaimRow {
        return {
            claimId: x.claim_id,
            cellId: x.cell_id,
            orgId: x.org_id,
            environmentId: x.environment_id,
            runId: x.run_id,
            side: x.side,
            state: x.state,
            consumer: x.consumer ?? null,
            hardExpiresAt: x.hard_expires_at.toISOString(),
            leaseExpiresAt: x.lease_expires_at.toISOString(),
            reason: x.reason ?? null,
            reasonDetail: x.reason_detail ?? null,
            stateChangedAt: x.state_changed_at ? x.state_changed_at.toISOString() : null,
            metering: x.driver ? { driver: x.driver, bootMb: x.memory_mb_boot ?? null, readyMb: x.memory_mb_ready ?? null, allocatableMb: x.memory_allocatable_mb ?? null } : null,
            admittedAt: x.admitted_at ? x.admitted_at.toISOString() : null,
            readyAt: x.ready_at ? x.ready_at.toISOString() : null,
            releasedAt: x.released_at ? x.released_at.toISOString() : null,
        };
    }
    async transitionClaim(claimId: string, from: readonly ClaimState[], to: ClaimState, cause: ClaimCause) {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_claims
                SET state = $3, reason = $4, reason_detail = $5, state_changed_at = now(),
                    released_at = CASE WHEN $3 IN ('released', 'terminated') THEN now() ELSE released_at END,
                    ready_at = CASE WHEN $4 = 'ready' THEN now() ELSE ready_at END
              WHERE claim_id = $1 AND state = ANY($2::text[])`,
            [claimId, [...from], to, cause.reason, cause.detail ?? null],
        );
        return r.rowCount === 1;
    }
    async rebindClaim(claimId: string, n: { cellId: string; leaseExpiresAt: string; hardExpiresAt: string; metering?: ClaimMetering | null }) {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_claims
                SET cell_id = $2, state = 'pending', lease_expires_at = $3, hard_expires_at = $4, released_at = NULL,
                    reason = 'reacquired', reason_detail = NULL, state_changed_at = now(),
                    driver = $6, memory_mb_boot = $7, memory_mb_ready = $8, memory_allocatable_mb = $9, admitted_at = now(), ready_at = NULL
              WHERE claim_id = $1 AND state = ANY($5::text[])`,
            [claimId, n.cellId, n.leaseExpiresAt, n.hardExpiresAt, [...OPEN_CLAIM_STATES], ...meteringValues(n.metering)],
        );
        return r.rowCount === 1;
    }
    async renewClaimLease(claimId: string, leaseExpiresAt: string, states: readonly ClaimState[]) {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_claims
                SET lease_expires_at = LEAST($2::timestamptz, hard_expires_at)
              WHERE claim_id = $1 AND state = ANY($3::text[]) AND lease_expires_at < LEAST($2::timestamptz, hard_expires_at)`,
            [claimId, leaseExpiresAt, [...states]],
        );
        return r.rowCount === 1;
    }
    async liveClaimsOfEnvironment(orgId: string, environmentId: string) {
        const r = await this.pool.query(
            `SELECT * FROM runtime.runtime_claims WHERE org_id = $1 AND environment_id = $2 AND state = 'bound' AND hard_expires_at > now()`,
            [orgId, environmentId],
        );
        return r.rows.map((x) => this.claimRow(x));
    }
    async liveClaimsOfCell(cellId: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_claims WHERE cell_id = $1 AND state = ANY($2::text[])`, [cellId, [...LIVE_CLAIM_STATES]]);
        return r.rows.map((x) => this.claimRow(x));
    }
    async approvedHosts(orgId: string, environmentId: string) {
        const r = await this.pool.query(
            `SELECT DISTINCT host FROM runtime.runtime_egress_approvals WHERE organization_id = $1 AND environment_id = $2 ORDER BY host`,
            [orgId, environmentId],
        );
        return r.rows.map((x) => x.host as string);
    }
    async recordClaimBlocker(b: ClaimBlockerRow) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_claim_blockers (claim_id, org_id, run_id, cell_id, side, kind, signature, message, at, log_tail)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (claim_id, kind, signature) DO NOTHING`,
            [
                b.claimId,
                b.orgId,
                b.runId ?? null,
                b.cellId,
                b.side,
                b.kind,
                b.signature.slice(0, 256),
                b.message.slice(0, 1_024),
                b.at,
                (b.logTail ?? []).slice(-40).map((l) => l.slice(0, 300)),
            ],
        );
    }
    async claimBlockers(claimIds: string[]) {
        if (!claimIds.length) return [];
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_claim_blockers WHERE claim_id = ANY($1::text[]) ORDER BY at`, [claimIds]);
        return r.rows.map((x) => ({
            claimId: x.claim_id,
            orgId: x.org_id,
            runId: x.run_id,
            cellId: x.cell_id,
            side: x.side,
            kind: x.kind,
            signature: x.signature,
            message: x.message,
            ...(x.log_tail?.length ? { logTail: x.log_tail as string[] } : {}),
            at: x.at.toISOString(),
        }));
    }
    async insertStep(s: StepRow, opts?: { requireFresh?: boolean }) {
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_steps_index (step_id, cell_id, claim_id, org_id, run_id, command_hash)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (step_id) DO NOTHING`,
            [s.stepId, s.cellId, s.claimId, s.orgId, s.runId ?? null, s.commandHash],
        );
        if (r.rowCount === 1) return true;
        if (opts?.requireFresh) return false;
        const prev = await this.step(s.stepId);
        return !!prev && prev.commandHash === s.commandHash && prev.claimId === s.claimId;
    }
    async step(stepId: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_steps_index WHERE step_id = $1`, [stepId]);
        const x = r.rows[0];
        return x ? { stepId: x.step_id, cellId: x.cell_id, claimId: x.claim_id, orgId: x.org_id, runId: x.run_id, commandHash: x.command_hash } : null;
    }
    async finishStep(stepId: string) {
        await this.pool.query(`UPDATE runtime.runtime_steps_index SET finished_at = now() WHERE step_id = $1`, [stepId]);
    }
    async insertEgress(e: { claimId: string; cellId: string; orgId: string; host: string; port: number; phase: string; at: string }) {
        await this.pool.query(`INSERT INTO runtime.runtime_egress_events (claim_id, cell_id, org_id, host, port, phase, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            e.claimId,
            e.cellId,
            e.orgId,
            e.host,
            e.port,
            e.phase,
            e.at,
        ]);
    }

    async registeredCell(cellId: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_cells WHERE cell_id = $1`, [cellId]);
        const x = r.rows[0];
        if (!x || !x.certificate_serial) return null;
        return {
            cellId: x.cell_id,
            organizationId: x.organization_id,
            owner: x.owner,
            topology: x.topology,
            status: x.status,
            certificateSerial: x.certificate_serial,
            certificateExpiresAt: x.certificate_expires_at?.toISOString() ?? new Date(0).toISOString(),
        };
    }
    async redeemAndRegister(token: string, topology: string, cell: (r: { organizationId: string; topology: string }) => RegisteredCell): Promise<RedeemResult> {
        if (!this.pool.connect) throw new Error('redeemAndRegister needs a pool');
        const client: PoolClient = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const r = await new CellTokenLedger(new PgCommandStore(client)).redeem(token, topology);
            if (r.ok) {
                const c = cell(r);
                await client.query(
                    `INSERT INTO runtime.runtime_cells (cell_id, organization_id, owner, topology, status, certificate_serial, certificate_expires_at)
                     VALUES ($1, $2, $3, $4, 'disconnected', $5, $6)`,
                    [c.cellId, c.organizationId, c.owner, c.topology, c.certificateSerial, c.certificateExpiresAt],
                );
            }
            await client.query('COMMIT');
            return r;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            client.release();
        }
    }
    async pinCertificate(cellId: string, serial: string, expiresAt: string) {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_cells SET certificate_serial = $2, certificate_expires_at = $3 WHERE cell_id = $1 AND status <> 'revoked'`,
            [cellId, serial, expiresAt],
        );
        return r.rowCount === 1;
    }
    async upsertManagedCell(c: { cellId: string; certificateSerial: string; certificateExpiresAt: string }) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_cells AS c (cell_id, organization_id, owner, topology, status, certificate_serial, certificate_expires_at, managed_serial)
             VALUES ($1, NULL, 'kodus', 'managed', 'disconnected', $2, $3, $2)
             ON CONFLICT (cell_id) DO UPDATE SET
               certificate_serial = CASE WHEN c.managed_serial IS DISTINCT FROM EXCLUDED.managed_serial OR c.certificate_serial = EXCLUDED.certificate_serial
                                         THEN EXCLUDED.certificate_serial ELSE c.certificate_serial END,
               certificate_expires_at = CASE WHEN c.managed_serial IS DISTINCT FROM EXCLUDED.managed_serial OR c.certificate_serial = EXCLUDED.certificate_serial
                                         THEN EXCLUDED.certificate_expires_at ELSE c.certificate_expires_at END,
               managed_serial = EXCLUDED.managed_serial
             WHERE c.status <> 'revoked'`,
            [c.cellId, c.certificateSerial, c.certificateExpiresAt],
        );
    }
    async cellPins() {
        const r = await this.pool.query(`SELECT cell_id, certificate_serial, status FROM runtime.runtime_cells`);
        return r.rows.map((x) => ({ cellId: x.cell_id, serial: x.certificate_serial, status: x.status }));
    }
    async filterRevoked(cellIds: string[]) {
        if (!cellIds.length) return [];
        const r = await this.pool.query(`SELECT cell_id FROM runtime.runtime_cells WHERE status = 'revoked' AND cell_id = ANY($1::text[])`, [cellIds]);
        return r.rows.map((x) => x.cell_id);
    }
}
