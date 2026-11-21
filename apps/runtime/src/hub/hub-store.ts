import { withTransaction } from '@libs/runtime/run/adapters/advisory-lock';
import type { Pool } from 'pg';

import { CellTokenLedger, type RedeemResult } from '@libs/runtime/contracts/cell-token';
import { type FleetRedeemResult, FleetTokenLedger } from '@libs/runtime/contracts/fleet-token';
import { KODUS_STATIC_POOL_ID, orgDefaultPoolId } from '@libs/runtime/fleet/pool';
import { ORG_EGRESS_SCOPE } from '@libs/runtime/contracts/egress';
import { assertClaimTransition, LIVE_CLAIM_STATES, REBINDABLE_CLAIM_STATES, type ClaimState } from '@libs/runtime/contracts/enums';
import type { Consumer } from '@libs/runtime/environment';
import { type ClaimStart, knownCellFeatures, type SharedImage } from '@libs/runtime/protocol';
import { SANDBOX_ENVIRONMENT_ID } from '@libs/runtime/protocol/sandbox';

import { reserveCellRow } from '../shared/persistence/cell-directory';
import { PgCommandStore } from '../shared/persistence/pg-command-store';
import { PgFleetTokenStore } from './enrollment/pg-fleet-token.store';
import type { CellCapabilities } from './cell-capabilities';

// What the hub keeps in the Runtime Postgres: which replica
// holds each cell, the claims, the stepId → cell, claim, org index and the
// egress events. Shared between replicas. The hub is the only writer of
// runtime_claims; every claim state change names the states it may leave
// (compare-and-set), so a late writer can never resurrect or kill a claim.

/** How long past its expiry a cell's certificate is still pinned and its revocation still kept: clock skew between the database and a hub. */
export const PIN_EXPIRY_MARGIN_HOURS = 1;

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
    /** With reason ready: how the cell says the workload came to be (claim.ready start). */
    start?: ClaimStart;
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
    /** The PR side of a pull request from a fork: the environment's approved egress hosts never reach it (false on rows from before migration 19). */
    forkPullRequest?: boolean;
    /** How the round's workload came to be, as its claim.ready said (migration 24); null until then, or from a cell that does not say. */
    start?: ClaimStart | null;
}

/**
 * What one acquire round of a claim holds, recorded once when the hub admits
 * it (migration 11), so the API prices a Run by what its claims held: the
 * cell's driver, and on a cell whose claims share its memory the
 * MB the hub counts the claim for while it boots and once ready, and what
 * the cell may commit to claims in all. The memory is null on a cell that
 * reports none (an aws-ec2 cell, one VM per claim; an older cell).
 */
export interface ClaimMetering {
    driver: string;
    bootMb: number | null;
    readyMb: number | null;
    allocatableMb: number | null;
    /** The vCPUs of the claim's machine size (migration 23); absent on a claim that asks none (the cell's default size). */
    cpus?: number | null;
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
    /**
     * The pool the cell belongs to (docs/runtime/host-providers.md §5.2), bound by the hub from the token it
     * registered with, never from what the cell says: an org token binds the org's default static pool, a fleet
     * token its pool, host and bound key. Absent on a row read from before pools: its owner's static pool.
     */
    poolId?: string | null;
    hostId?: string | null;
    /** A perRun host's cell serves only claims of this key (`run:<org>/<runId>`). */
    boundKey?: string | null;
}

export interface CellSessionRepository {
    /** Records the session on this replica and marks the cell connected (one statement). */
    upsertSession(s: CellSession): Promise<void>;
    heartbeat(cellId: string, replicaId: string, freeSlots: number,
        sessionEpoch?: string,
        /** The cell's heartbeat memory, when the hub decided to persist it now (throttled by the caller). */
        memory?: { allocatableMb: number; committedMb: number },
        /** The cell's heartbeat sandbox pool, when the hub decided to persist it now (throttled by the caller). */
        sandboxPool?: { target: number; ready: number },
    ): Promise<void>;
    /** Ends the session only if this replica still holds it; the cell row follows only then. */
    disconnect(cellId: string, replicaId: string,
        sessionEpoch?: string): Promise<void>;
    /**
     * A connected cell that may serve this org (its own cells, or a managed
     * one), with one slot taken from its last reported free slots so
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
    /**
     * Moves the claim to `to` only when its current state is one of `from`; true when it moved.
     * Throws InvalidClaimTransitionError when any `from` may not reach `to` (contracts/enums.ts CLAIM_TRANSITIONS).
     */
    transitionClaim(claimId: string, from: readonly ClaimState[], to: ClaimState, cause: ClaimCause): Promise<boolean>;
    /** A new acquire round: the claim (any open state but compromised) belongs to cellId, pending again, admitted now with this round's metering. */
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
    /** false when the stepId already exists with another command or claim. */
    insertStep(s: StepRow, opts?: { requireFresh?: boolean }): Promise<boolean>;
    step(stepId: string): Promise<StepRow | null>;
    finishStep(stepId: string): Promise<void>;
    insertEgress(e: { claimId: string; cellId: string; orgId: string; host: string; port: number; phase: string; at: string }): Promise<void>;
    /** The hosts approved for an environment (runtime_egress_approvals): a new claim gets them after claim.ready. */
    approvedHosts(orgId: string, environmentId: string): Promise<string[]>;
    /**
     * What a claim of the environment gets (docs/runtime/egress-allowlist.md §9): its approvals and the org list
     * (ORG_EGRESS_SCOPE; never for the sandbox environment, G5), none revoked; inspect are the hosts approved as
     * inspected with their path prefixes.
     */
    approvedEgress(orgId: string, environmentId: string): Promise<ApprovedEgress>;
    /** Whether the org keeps the Kodus recommended list on (D2); true when it never said. */
    egressRecommendedEnabled(orgId: string): Promise<boolean>;
    /** A claim just got these hosts of the environment (D5: the screen shows each approval's last use). Best effort. */
    markEgressSent(orgId: string, environmentId: string, hosts: string[], at: Date): Promise<void>;
    /** Every live claim of the org, for an org-list change. */
    liveClaimsOfOrganization(orgId: string): Promise<ClaimRow[]>;
    /** One sandbox operation, per org (runtime_sandbox_audit): what, where, and how it ended. Never the command's output or a file's content. */
    recordSandboxAudit(r: SandboxAuditRow): Promise<void>;
}

/** An environment's approved egress: every host, and the ones approved as inspected with their paths. */
export interface ApprovedEgress {
    allow: string[];
    inspect: Array<{ host: string; paths: string[] }>;
}

/** One sandbox operation as the hub audits it. command is the exec's command line, redacted; path the file op's path. */
export interface SandboxAuditRow {
    orgId: string;
    claimId: string;
    cellId: string;
    stepId: string;
    op: string;
    command?: string;
    path?: string;
    outcome: 'ok' | 'refused' | 'failed';
    detail?: string;
    exitCode?: number;
    bytes?: number;
    durationMs: number;
    at: string;
}

export interface CellRegistryRepository {
    /** A registered cell: its pinned certificate serial, owner, org and status. */
    registeredCell(cellId: string): Promise<RegisteredCell | null>;
    /**
     * Redeems a registration token and, when it is good, inserts the cell, in
     * one transaction: a database error never burns the token. A refused
     * token (expired, wrong topology) is still burned (single use).
     */
    redeemAndRegister(token: string, topology: string | undefined, cell: (redeemed: { organizationId: string; topology: string }) => RegisteredCell): Promise<RedeemResult>;
    /** The same for a kcf_ fleet token: the cell row carries the token's pool, host and bound key (§8.1). */
    redeemFleetAndRegister(token: string, cell: (redeemed: { poolId: string; hostId: string; boundKey: string | null }) => RegisteredCell): Promise<FleetRedeemResult>;
    /** The pool's provider and lifecycle, or null when no such pool: only a pool a controller drives takes fleet tokens. */
    hostPool(poolId: string): Promise<{ provider: string; lifecycle: string } | null>;
    /** Cordons and revokes the cell of a fleet host (its live claims end with it); the cell's id, or null when none registered. */
    retireHostCell(hostId: string, by: string): Promise<string | null>;
    /** Moves the pin to a renewed certificate; false when the cell is revoked or unknown. */
    pinCertificate(cellId: string, serial: string, expiresAt: string): Promise<boolean>;
    /**
     * A managed cell from config: creates its row, or re-pins it when the
     * configured serial changed since the last boot (a new dev-ca certificate).
     * Same serial as last boot: a pin the cell renewed since stays. Never un-revokes.
     */
    upsertManagedCell(c: { cellId: string; certificateSerial: string; certificateExpiresAt: string }): Promise<void>;
    /**
     * The pins of the cells whose certificate has not expired (an hour of margin for clock skew): an expired
     * certificate never passes the TLS handshake, so its serial needs no pin and no revocation entry. Every
     * hub replica reads this every 5 s; a perRun pool leaves a cell row per Run behind.
     */
    cellPins(): Promise<Array<{ cellId: string; serial: string | null; status: string }>>;
    /** Of these cells, the ones revoked since they connected. */
    filterRevoked(cellIds: string[]): Promise<string[]>;
    /** Of these cells, the ones whose newest certificate expired by `at` (not renewed): their open sessions end. */
    filterExpired(cellIds: string[], at: string): Promise<string[]>;
}

/** An environment whose build state a cell's disk floor removed (heartbeat evictedBuildStates). */
export interface EvictedBuildStateRow {
    orgId: string;
    environmentId: string;
    evictedAt: string;
    /** How long the build that made the state from none took (heartbeat rebuildSeconds); absent: not measured. */
    rebuildSeconds?: number;
}

/**
 * runtime_build_state_evictions: what each cell said in its last heartbeat
 * of the environments whose build state its disk floor removed and no setup
 * made again. The hub writes it; the API reads it (needs setup again) and the
 * hub reads it into a claim's outcome (a build that ran cold because of it).
 */
export interface BuildStateRepository {
    /** The cell's whole list: rows it no longer names go (a setup made the state again). */
    syncEvictedBuildStates(cellId: string, rows: EvictedBuildStateRow[]): Promise<void>;
    /** When the cell's disk floor removed the environment's build state, when it did and the cell still says so. */
    evictedBuildStateAt(cellId: string, orgId: string, environmentId: string): Promise<string | null>;
    /** The environment's row of the cell's list, with what the state cost to make; null when the cell does not name it. */
    evictedBuildState(cellId: string, orgId: string, environmentId: string): Promise<EvictedBuildStateRow | null>;
}

/** An image.bake the hub sent (runtime_bake_asks): the bake key and when. */
export interface BakeAskRow {
    cellId: string;
    orgId: string;
    environmentId: string;
    /** The bake's sha, or its refsDigest for an environment of several repositories. */
    envKey: string;
    recipeSha: string;
    askedAt: string;
}

/** What a cell said it pushed for one bake (image.shared), keyed as its image.bake was. */
export interface SharedBakeRecord {
    cellId: string;
    orgId: string;
    environmentId: string;
    envKey: string;
    recipeSha: string;
    images: SharedImage[];
    pushedAt: string;
}

/** The bakes per environment whose shared images the hub keeps. */
export const SHARED_IMAGE_BAKES_KEPT = 2;
/** How long after its image.bake a bake's image.shared is taken (the bake's 90 min and the push's 30, with room). */
export const BAKE_ASK_TTL_MS = 6 * 3_600_000;

/**
 * runtime_shared_images (docs/runtime/shared-baked-environments.md §8): the
 * baked images of an org's environments in the org's registry, by build
 * fingerprint. Written only from an image.shared that answers an image.bake
 * the hub asked of that cell for that org; the newest bake (by its ask) wins a
 * fingerprint; the last SHARED_IMAGE_BAKES_KEPT bakes stay.
 */
export interface SharedImageRepository {
    recordBakeAsk(a: BakeAskRow): Promise<void>;
    /** not_asked: no image.bake of this key was sent to this cell for this org within BAKE_ASK_TTL_MS; nothing written. */
    recordSharedImages(r: SharedBakeRecord): Promise<'recorded' | 'not_asked'>;
    /** The environment's shared images, newest bake first. */
    sharedImages(orgId: string, environmentId: string, limit: number): Promise<SharedImage[]>;
    /** The environment is gone: its records go (the registry's lifecycle rule removes the images). */
    removeSharedImages(orgId: string, environmentId: string): Promise<number>;
}

/** Everything the hub persists, one repository per aggregate. */
export interface HubStore extends CellSessionRepository, ClaimRepository, ClaimBlockerRepository, StepRepository, CellRegistryRepository, BuildStateRepository, SharedImageRepository {}

type Queryable = Pick<Pool, 'query'>;

/** A session with no cell row (the plaintext test mode) is pooled by its owner ($4 owner, $5 org of upsertSession). */
const SESSION_POOL_BY_OWNER = `CASE WHEN $4 = 'customer' AND $5::text IS NOT NULL THEN 'org:' || $5::text || '/default' ELSE '${KODUS_STATIC_POOL_ID}' END`;

/** The five metering columns of a claim row, null when the round recorded none. */
const meteringValues = (m: ClaimMetering | null | undefined) => [m?.driver ?? null, m?.bootMb ?? null, m?.readyMb ?? null, m?.allocatableMb ?? null, m?.cpus ?? null];

export class PgHubStore implements HubStore {
    constructor(private readonly pool: Queryable & Partial<Pick<Pool, 'connect'>>) {}

    async upsertSession(s: CellSession) {
        await this.pool.query(
            `WITH s AS (
               INSERT INTO runtime.runtime_cell_sessions (cell_id, replica_id, replica_url, owner, org_id, driver, features, max_claim_memory_mb, max_claim_cpus, session_epoch, isolation,
                 default_claim_memory_mb, default_claim_cpus, sandbox_claim_memory_mb, sandbox_claim_cpus, connected_at, last_heartbeat_at, disconnected_at,
                 pool_id, bound_key, cordoned_at)
               -- The pool, binding and cordon come from the cell row the hub wrote at registration, never from the hello.
               SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), now(), NULL,
                      COALESCE(c.pool_id, ${SESSION_POOL_BY_OWNER}), c.bound_key, c.cordoned_at
                 FROM (SELECT 1) one LEFT JOIN runtime.runtime_cells c ON c.cell_id = $1
               ON CONFLICT (cell_id) DO UPDATE SET replica_id = EXCLUDED.replica_id, replica_url = EXCLUDED.replica_url, owner = EXCLUDED.owner,
                 org_id = EXCLUDED.org_id, driver = EXCLUDED.driver, features = EXCLUDED.features,
                 max_claim_memory_mb = EXCLUDED.max_claim_memory_mb, max_claim_cpus = EXCLUDED.max_claim_cpus,
                 session_epoch = EXCLUDED.session_epoch, isolation = EXCLUDED.isolation,
                 default_claim_memory_mb = EXCLUDED.default_claim_memory_mb, default_claim_cpus = EXCLUDED.default_claim_cpus,
                 sandbox_claim_memory_mb = EXCLUDED.sandbox_claim_memory_mb, sandbox_claim_cpus = EXCLUDED.sandbox_claim_cpus,
                 connected_at = now(), last_heartbeat_at = now(), disconnected_at = NULL,
                 pool_id = EXCLUDED.pool_id, bound_key = EXCLUDED.bound_key, cordoned_at = EXCLUDED.cordoned_at
               RETURNING cell_id)
             UPDATE runtime.runtime_cells c SET status = 'connected', last_heartbeat_at = now() FROM s WHERE c.cell_id = s.cell_id AND c.status <> 'revoked'`,
            // Every hello rewrites the capabilities: a cell that reconnects downgraded loses what it no longer names.
            [s.cellId, s.replicaId, s.replicaUrl, s.owner, s.orgId ?? null, s.driver, [...(s.features ?? [])], s.maxClaimSize?.memoryMb ?? null, s.maxClaimSize?.cpus ?? null,
                s.sessionEpoch ?? null,
                s.isolation ?? null,
                s.defaultClaimSize?.memoryMb ?? null,
                s.defaultClaimSize?.cpus ?? null,
                s.sandboxClaimSize?.memoryMb ?? null,
                s.sandboxClaimSize?.cpus ?? null,
            ],
        );
    }
    async heartbeat(cellId: string, replicaId: string, freeSlots: number,
        sessionEpoch?: string,
        memory?: { allocatableMb: number; committedMb: number },
        sandboxPool?: { target: number; ready: number },
    ) {
        await this.pool.query(
            `UPDATE runtime.runtime_cell_sessions SET last_heartbeat_at = now(), free_slots = $3,
               memory_allocatable_mb = COALESCE($5::integer, memory_allocatable_mb), memory_committed_mb = COALESCE($6::integer, memory_committed_mb),
               sandbox_pool_target = COALESCE($7::integer, sandbox_pool_target), sandbox_pool_ready = COALESCE($8::integer, sandbox_pool_ready)
              WHERE cell_id = $1 AND replica_id = $2 AND ($4::text IS NULL OR session_epoch::text = $4)`, [
            cellId,
            replicaId,
            freeSlots, sessionEpoch ?? null, memory?.allocatableMb ?? null, memory?.committedMb ?? null, sandboxPool?.target ?? null, sandboxPool?.ready ?? null]);
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
            defaultClaimSize: r.default_claim_memory_mb != null && r.default_claim_cpus != null ? { memoryMb: r.default_claim_memory_mb, cpus: r.default_claim_cpus } : null,
            sandboxClaimSize: r.sandbox_claim_memory_mb != null && r.sandbox_claim_cpus != null ? { memoryMb: r.sandbox_claim_memory_mb, cpus: r.sandbox_claim_cpus } : null,
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
                                                 driver, memory_mb_boot, memory_mb_ready, memory_allocatable_mb, cpus, admitted_at, fork_pull_request)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'acquired', now(), $11, $12, $13, $14, $15, now(), $16) ON CONFLICT (claim_id) DO NOTHING`,
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
                c.forkPullRequest === true,
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
            metering: x.driver
                ? {
                      driver: x.driver,
                      bootMb: x.memory_mb_boot ?? null,
                      readyMb: x.memory_mb_ready ?? null,
                      allocatableMb: x.memory_allocatable_mb ?? null,
                      ...(x.cpus != null ? { cpus: x.cpus } : {}),
                  }
                : null,
            admittedAt: x.admitted_at ? x.admitted_at.toISOString() : null,
            readyAt: x.ready_at ? x.ready_at.toISOString() : null,
            releasedAt: x.released_at ? x.released_at.toISOString() : null,
            forkPullRequest: x.fork_pull_request === true,
            start: x.start_source ?? null,
        };
    }
    async transitionClaim(claimId: string, from: readonly ClaimState[], to: ClaimState, cause: ClaimCause) {
        assertClaimTransition(from, to);
        const r = await this.pool.query(
            `UPDATE runtime.runtime_claims
                SET state = $3, reason = $4, reason_detail = $5, state_changed_at = now(),
                    released_at = CASE WHEN $3 IN ('released', 'terminated') THEN now() ELSE released_at END,
                    ready_at = CASE WHEN $4 = 'ready' THEN now() ELSE ready_at END,
                    start_source = CASE WHEN $4 = 'ready' THEN $6::text ELSE start_source END
              WHERE claim_id = $1 AND state = ANY($2::text[])`,
            [claimId, [...from], to, cause.reason, cause.detail ?? null, cause.start ?? null],
        );
        return r.rowCount === 1;
    }
    async rebindClaim(claimId: string, n: { cellId: string; leaseExpiresAt: string; hardExpiresAt: string; metering?: ClaimMetering | null }) {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_claims
                SET cell_id = $2, state = 'pending', lease_expires_at = $3, hard_expires_at = $4, released_at = NULL,
                    reason = 'reacquired', reason_detail = NULL, state_changed_at = now(),
                    driver = $6, memory_mb_boot = $7, memory_mb_ready = $8, memory_allocatable_mb = $9, cpus = $10, admitted_at = now(), ready_at = NULL, start_source = NULL
              WHERE claim_id = $1 AND state = ANY($5::text[])`,
            [claimId, n.cellId, n.leaseExpiresAt, n.hardExpiresAt, [...REBINDABLE_CLAIM_STATES], ...meteringValues(n.metering)],
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
        // Every heartbeat reads this. A live claim never has released_at (only released and terminated set it, and a
        // rebind clears it), and saying so puts the read on runtime_claims_org_live_idx, which holds only open claims:
        // without it the plan walked runtime_claims_cell_idx over the cell's whole claim history.
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_claims WHERE cell_id = $1 AND released_at IS NULL AND state = ANY($2::text[])`, [
            cellId,
            [...LIVE_CLAIM_STATES],
        ]);
        return r.rows.map((x) => this.claimRow(x));
    }
    async approvedHosts(orgId: string, environmentId: string) {
        return (await this.approvedEgress(orgId, environmentId)).allow;
    }
    async approvedEgress(orgId: string, environmentId: string) {
        const scopes = environmentId === SANDBOX_ENVIRONMENT_ID ? [environmentId] : [environmentId, ORG_EGRESS_SCOPE];
        // The environment's own row wins over the org list's for the same host (its mode and paths).
        const r = await this.pool.query(
            `SELECT DISTINCT ON (host) host, mode, path_prefixes FROM runtime.runtime_egress_approvals
              WHERE organization_id = $1 AND environment_id = ANY($2::text[]) AND revoked_at IS NULL
              ORDER BY host, (environment_id = $3) DESC LIMIT 256`,
            [orgId, scopes, ORG_EGRESS_SCOPE],
        );
        const rows = r.rows as Array<{ host: string; mode: string; path_prefixes: string[] | null }>;
        return {
            allow: rows.map((x) => x.host),
            inspect: rows.filter((x) => x.mode === 'inspected' && x.path_prefixes?.length).map((x) => ({ host: x.host, paths: x.path_prefixes! })),
        };
    }
    async egressRecommendedEnabled(orgId: string) {
        const r = await this.pool.query(`SELECT recommended_enabled FROM runtime.runtime_egress_settings WHERE organization_id = $1`, [orgId]);
        return r.rows.length ? r.rows[0].recommended_enabled !== false : true;
    }
    async markEgressSent(orgId: string, environmentId: string, hosts: string[], at: Date) {
        if (!hosts.length) return;
        const scopes = environmentId === SANDBOX_ENVIRONMENT_ID ? [environmentId] : [environmentId, ORG_EGRESS_SCOPE];
        await this.pool.query(
            `UPDATE runtime.runtime_egress_approvals SET last_sent_at = $4::timestamptz
              WHERE organization_id = $1 AND environment_id = ANY($2::text[]) AND host = ANY($3::text[]) AND revoked_at IS NULL
                AND (last_sent_at IS NULL OR last_sent_at < $4::timestamptz - interval '1 minute')`,
            [orgId, scopes, hosts, at],
        );
    }
    async liveClaimsOfOrganization(orgId: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_claims WHERE org_id = $1 AND state = 'bound' AND hard_expires_at > now()`, [orgId]);
        return r.rows.map((x) => this.claimRow(x));
    }
    async recordSandboxAudit(a: SandboxAuditRow) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_sandbox_audit (org_id, claim_id, cell_id, step_id, op, command, path, outcome, detail, exit_code, bytes, duration_ms, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [a.orgId, a.claimId, a.cellId, a.stepId, a.op, a.command?.slice(0, 2_048) ?? null, a.path?.slice(0, 4_096) ?? null, a.outcome, a.detail?.slice(0, 256) ?? null, a.exitCode ?? null, a.bytes ?? null, a.durationMs, a.at],
        );
    }
    async syncEvictedBuildStates(cellId: string, rows: EvictedBuildStateRow[]) {
        // One statement: the cell's rows become exactly its list.
        await this.pool.query(
            `WITH listed AS (
               SELECT * FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::integer[]) AS l(org_id, environment_id, evicted_at, rebuild_seconds)),
             gone AS (
               DELETE FROM runtime.runtime_build_state_evictions e WHERE e.cell_id = $1
                AND NOT EXISTS (SELECT 1 FROM listed l WHERE l.org_id = e.org_id AND l.environment_id = e.environment_id))
             INSERT INTO runtime.runtime_build_state_evictions (cell_id, org_id, environment_id, evicted_at, rebuild_seconds)
             SELECT $1, org_id, environment_id, evicted_at, rebuild_seconds FROM listed
             ON CONFLICT (cell_id, org_id, environment_id) DO UPDATE SET evicted_at = EXCLUDED.evicted_at, rebuild_seconds = EXCLUDED.rebuild_seconds`,
            [cellId, rows.map((r) => r.orgId), rows.map((r) => r.environmentId), rows.map((r) => r.evictedAt), rows.map((r) => r.rebuildSeconds ?? null)],
        );
    }
    async evictedBuildStateAt(cellId: string, orgId: string, environmentId: string) {
        const r = await this.pool.query(
            `SELECT evicted_at FROM runtime.runtime_build_state_evictions WHERE cell_id = $1 AND org_id = $2 AND environment_id = $3`,
            [cellId, orgId, environmentId],
        );
        const at = r.rows[0]?.evicted_at;
        return at ? new Date(at).toISOString() : null;
    }
    async evictedBuildState(cellId: string, orgId: string, environmentId: string) {
        const r = await this.pool.query(
            `SELECT evicted_at, rebuild_seconds FROM runtime.runtime_build_state_evictions WHERE cell_id = $1 AND org_id = $2 AND environment_id = $3`,
            [cellId, orgId, environmentId],
        );
        const row = r.rows[0];
        if (!row) return null;
        return { orgId, environmentId, evictedAt: new Date(row.evicted_at).toISOString(), ...(row.rebuild_seconds ? { rebuildSeconds: Number(row.rebuild_seconds) } : {}) };
    }
    async recordBakeAsk(a: BakeAskRow) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_bake_asks (cell_id, org_id, environment_id, env_key, recipe_sha, asked_at) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (cell_id, org_id, environment_id, env_key, recipe_sha) DO UPDATE SET asked_at = EXCLUDED.asked_at`,
            [a.cellId, a.orgId, a.environmentId, a.envKey, a.recipeSha, a.askedAt],
        );
    }
    async recordSharedImages(r: SharedBakeRecord) {
        // The ask orders the bakes: a fingerprint takes a record only from a bake asked no earlier than its own.
        const asked = await this.pool.query(
            `WITH ask AS (
               SELECT asked_at FROM runtime.runtime_bake_asks
                WHERE cell_id = $1 AND org_id = $2 AND environment_id = $3 AND env_key = $4 AND recipe_sha = $5
                  AND asked_at > $6::timestamptz - make_interval(secs => $7::double precision)),
             up AS (
               INSERT INTO runtime.runtime_shared_images AS s (org_id, environment_id, env_key, recipe_sha, fingerprint, digest, cell_id, asked_at, pushed_at)
               SELECT $2, $3, $4, $5, i.fingerprint, i.digest, $1, ask.asked_at, $6 FROM ask, unnest($8::text[], $9::text[]) AS i(fingerprint, digest)
               ON CONFLICT (org_id, environment_id, fingerprint) DO UPDATE SET env_key = EXCLUDED.env_key, recipe_sha = EXCLUDED.recipe_sha, digest = EXCLUDED.digest,
                 cell_id = EXCLUDED.cell_id, asked_at = EXCLUDED.asked_at, pushed_at = EXCLUDED.pushed_at, last_pulled_at = NULL
               WHERE s.asked_at <= EXCLUDED.asked_at
               RETURNING 1)
             SELECT (SELECT count(*) FROM ask) AS asked, (SELECT count(*) FROM up) AS written`,
            [r.cellId, r.orgId, r.environmentId, r.envKey, r.recipeSha, r.pushedAt, BAKE_ASK_TTL_MS / 1000, r.images.map((i) => i.fingerprint), r.images.map((i) => i.digest)],
        );
        if (Number(asked.rows[0]?.asked ?? 0) === 0) return 'not_asked';
        await this.pool.query(
            `DELETE FROM runtime.runtime_shared_images WHERE org_id = $1 AND environment_id = $2 AND asked_at NOT IN (
               SELECT DISTINCT asked_at FROM runtime.runtime_shared_images WHERE org_id = $1 AND environment_id = $2 ORDER BY asked_at DESC LIMIT $3)`,
            [r.orgId, r.environmentId, SHARED_IMAGE_BAKES_KEPT],
        );
        return 'recorded';
    }
    async sharedImages(orgId: string, environmentId: string, limit: number) {
        const r = await this.pool.query(
            `SELECT fingerprint, digest FROM runtime.runtime_shared_images WHERE org_id = $1 AND environment_id = $2 ORDER BY asked_at DESC, fingerprint LIMIT $3`,
            [orgId, environmentId, limit],
        );
        return r.rows.map((x) => ({ fingerprint: String(x.fingerprint), digest: String(x.digest) }));
    }
    async removeSharedImages(orgId: string, environmentId: string) {
        return (await this.pool.query(`DELETE FROM runtime.runtime_shared_images WHERE org_id = $1 AND environment_id = $2`, [orgId, environmentId])).rowCount ?? 0;
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
            poolId: x.pool_id ?? null,
            hostId: x.host_id ?? null,
            boundKey: x.bound_key ?? null,
        };
    }
    async redeemAndRegister(token: string, topology: string | undefined, cell: (r: { organizationId: string; topology: string }) => RegisteredCell): Promise<RedeemResult> {
        if (!this.pool.connect) throw new Error('redeemAndRegister needs a pool');
        return withTransaction(this.pool as Pick<Pool, 'connect'>, async (client) => {
            const r = await new CellTokenLedger(new PgCommandStore(client)).redeem(token, topology);
            if (r.ok) {
                const c = cell(r);
                const poolId = c.poolId ?? orgDefaultPoolId(r.organizationId);
                // An org's default pool is static and made at its first registration.
                await client.query(
                    `INSERT INTO runtime.runtime_host_pools (pool_id, scope, organization_id, provider, lifecycle) VALUES ($1, 'org:' || $2, $2, 'static', 'pooled') ON CONFLICT DO NOTHING`,
                    [orgDefaultPoolId(r.organizationId), r.organizationId],
                );
                await client.query(
                    `INSERT INTO runtime.runtime_cells (cell_id, organization_id, owner, topology, status, certificate_serial, certificate_expires_at, pool_id, host_id, bound_key)
                     VALUES ($1, $2, $3, $4, 'disconnected', $5, $6, $7, $8, $9)`,
                    [c.cellId, c.organizationId, c.owner, c.topology, c.certificateSerial, c.certificateExpiresAt, poolId, c.hostId ?? null, c.boundKey ?? null],
                );
            }
            return r;
        });
    }
    async redeemFleetAndRegister(token: string, cell: (r: { poolId: string; hostId: string; boundKey: string | null }) => RegisteredCell): Promise<FleetRedeemResult> {
        if (!this.pool.connect) throw new Error('redeemFleetAndRegister needs a pool');
        return withTransaction(this.pool as Pick<Pool, 'connect'>, async (client) => {
            const r = await new FleetTokenLedger(new PgFleetTokenStore(client)).redeem(token);
            if (r.ok) {
                const c = cell(r);
                await client.query(
                    `INSERT INTO runtime.runtime_cells (cell_id, organization_id, owner, topology, status, certificate_serial, certificate_expires_at, pool_id, host_id, bound_key)
                     VALUES ($1, NULL, 'kodus', 'fleet', 'disconnected', $2, $3, $4, $5, $6)`,
                    [c.cellId, c.certificateSerial, c.certificateExpiresAt, r.poolId, r.hostId, r.boundKey],
                );
            }
            return r;
        });
    }
    async hostPool(poolId: string) {
        const r = await this.pool.query(`SELECT provider, lifecycle FROM runtime.runtime_host_pools WHERE pool_id = $1`, [poolId]);
        return r.rows[0] ? { provider: r.rows[0].provider as string, lifecycle: r.rows[0].lifecycle as string } : null;
    }
    async retireHostCell(hostId: string, by: string) {
        const r = await this.pool.query(`SELECT cell_id FROM runtime.runtime_cells WHERE host_id = $1 AND topology = 'fleet'`, [hostId]);
        const cellId = r.rows[0]?.cell_id as string | undefined;
        if (!cellId) return null;
        // Cordon first (placement skips it at once), then revoke: the hub drops the connection and its live claims end.
        await this.pool.query(`UPDATE runtime.runtime_cells SET cordoned_at = COALESCE(cordoned_at, now()) WHERE cell_id = $1`, [cellId]);
        await this.pool.query(`UPDATE runtime.runtime_cell_sessions SET cordoned_at = COALESCE(cordoned_at, now()) WHERE cell_id = $1`, [cellId]);
        const status = (await this.pool.query(`SELECT status FROM runtime.runtime_cells WHERE cell_id = $1`, [cellId])).rows[0]?.status;
        if (status !== 'revoked') await new PgCommandStore(this.pool).revokeCell({ cellId, reason: 'fleet_host_retired', revokedBy: by });
        return cellId;
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
            `INSERT INTO runtime.runtime_cells AS c (cell_id, organization_id, owner, topology, status, certificate_serial, certificate_expires_at, managed_serial, pool_id)
             VALUES ($1, NULL, 'kodus', 'managed', 'disconnected', $2, $3, $2, '${KODUS_STATIC_POOL_ID}')
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
        const r = await this.pool.query(
            `SELECT cell_id, certificate_serial, status FROM runtime.runtime_cells
              WHERE certificate_expires_at IS NULL OR certificate_expires_at > now() - interval '${PIN_EXPIRY_MARGIN_HOURS} hours'`,
        );
        return r.rows.map((x) => ({ cellId: x.cell_id, serial: x.certificate_serial, status: x.status }));
    }
    async filterRevoked(cellIds: string[]) {
        if (!cellIds.length) return [];
        const r = await this.pool.query(`SELECT cell_id FROM runtime.runtime_cells WHERE status = 'revoked' AND cell_id = ANY($1::text[])`, [cellIds]);
        return r.rows.map((x) => x.cell_id);
    }
    async filterExpired(cellIds: string[], at: string) {
        if (!cellIds.length) return [];
        const r = await this.pool.query(`SELECT cell_id FROM runtime.runtime_cells WHERE cell_id = ANY($1::text[]) AND certificate_expires_at <= $2::timestamptz`, [cellIds, at]);
        return r.rows.map((x) => x.cell_id);
    }
}
