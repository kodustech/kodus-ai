import { createHash } from 'crypto';

import type { Pool } from 'pg';

import type { PreviewAuditAction, PreviewSide, PreviewState } from '@libs/runtime/contracts/preview';
import type { RunClaimUsage } from '@libs/runtime/api/domain/run-cost';

// Preview URLs (docs/runtime/preview-urls.md) in the Runtime Postgres
// (migration 27). Three writers, each of its own columns:
//   - the worker: a preview's record and state (open, start, wake, sleep, stop, expire);
//   - the hub: the one-time tickets it sends a cell for its tunnel;
//   - the edge: activity and wake requests on a preview, its cookie sessions,
//     the grants it has seen, and which replica holds a cell's tunnel.
// Every read of a preview by id names the org; the edge reads by host only
// (a random name, §6.2) and checks the org on the grant and the session.

export interface PreviewRow {
    previewId: string;
    organizationId: string;
    environmentId: string;
    repositoryId: string;
    repositoryFullName: string;
    /** Absent: the environment's own preview (migration 28). */
    runId?: string;
    /** The pull request of the Run: a newer Run of it, or its closing, ends the preview. */
    prNumber?: number;
    side: PreviewSide;
    sha: string;
    host: string;
    state: PreviewState;
    reason?: string;
    openedBy: string;
    withoutSecrets: boolean;
    /** The PR side of a fork's pull request: no approved hosts, no secrets (decision 6). */
    forkPullRequest: boolean;
    /** The policy of the last open (PreviewPolicy); absent on a row from before migration 28: the defaults. */
    idleMinutes?: number;
    ceilingMinutes?: number;
    monthlyMachineMinutes?: number;
    /** How many claims this preview has had: each start acquires `preview:<id>:<starts>`. */
    starts: number;
    claimId?: string;
    cellId?: string;
    target?: { service: string; port: number };
    leaseExpiresAt?: string;
    claimHardExpiresAt?: string;
    /** Sealed to previewTokenBinding(previewId); a wake opens it in the acquire only. */
    sealedRepoToken?: string;
    tokenSealedAt?: string;
    wakeRequestedAt?: string;
    lastActivityAt?: string;
    readyAt?: string;
    routedAt?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}

export interface PreviewSessionRow {
    sessionHash: string;
    previewId: string;
    organizationId: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    closedAt?: string;
}

export interface PreviewAuditEntry {
    organizationId: string;
    previewId: string;
    runId?: string;
    side?: PreviewSide;
    /** A user id; never an IP, a path or a token. */
    actor?: string;
    action: PreviewAuditAction | 'session_closed';
    reason?: string;
    requests?: number;
    bytesIn?: number;
    bytesOut?: number;
    at?: string;
}

/** The fields of a preview the worker may change after insert. */
export type PreviewPatch = Partial<Omit<PreviewRow, 'previewId' | 'organizationId' | 'host' | 'runId' | 'prNumber' | 'side' | 'environmentId' | 'repositoryId' | 'createdAt'>>;

/** Where an edge replica holds a cell's tunnel, and the internal URL another replica forwards to. */
export interface TunnelHolder {
    replica: string;
    url?: string;
}

export interface PreviewStore {
    // worker
    insertPreview(row: PreviewRow): Promise<boolean>;
    getPreview(organizationId: string, previewId: string): Promise<PreviewRow | null>;
    /** Applies the patch only when the row is in one of `from` (a transition); true when it moved. */
    updatePreview(organizationId: string, previewId: string, patch: PreviewPatch, from?: readonly PreviewState[]): Promise<boolean>;
    /** Previews a worker tick may act on: every one not stopped or expired, oldest touched first. */
    listOpenPreviews(limit: number): Promise<PreviewRow[]>;
    /** Whether an edge replica holds a tunnel of this cell seen since `since`. */
    tunnelHeld(cellId: string, since: string): Promise<boolean>;
    audit(entry: PreviewAuditEntry): Promise<void>;
    /** The open previews of a pull request's Runs: a newer Run or the PR closing ends them. */
    openPreviewsOfPullRequest(organizationId: string, repositoryId: string, prNumber: number): Promise<PreviewRow[]>;
    /** The open previews of an environment itself (no Run): a newer bake's preview ends them. */
    openEnvironmentPreviews(organizationId: string, environmentId: string): Promise<PreviewRow[]>;
    /** The security_violation the cell reported on each of these claims (its signature), if any: the preview stops on it. */
    securityViolations(claims: ReadonlyArray<{ organizationId: string; claimId: string }>): Promise<Map<string, string>>;
    /** The org's preview claims created since `since`, as the usage report reads them: what the monthly cap counts. */
    previewClaimsSince(organizationId: string, since: string): Promise<RunClaimUsage[]>;
    // hub
    insertTunnelTicket(ticketHash: string, cellId: string, expiresAt: string): Promise<void>;
    // edge
    previewByHost(host: string): Promise<PreviewRow | null>;
    /** Deletes the ticket and says whether it was this cell's and still valid: single use. */
    consumeTunnelTicket(ticketHash: string, cellId: string, now: string): Promise<boolean>;
    /** Whether the cell's row pins this certificate serial and the cell is not revoked. */
    cellCertificatePinned(cellId: string, serial: string, now: string): Promise<boolean>;
    holdTunnel(cellId: string, replica: string, now: string, url?: string): Promise<void>;
    /** Who holds the cell's tunnel, seen since `since`; null: no replica does. */
    tunnelHolder(cellId: string, since: string): Promise<TunnelHolder | null>;
    releaseTunnel(cellId: string, replica: string): Promise<void>;
    /** Records a grant's jti; false when it was seen before (a replay). */
    useGrant(jti: string, expiresAt: string): Promise<boolean>;
    createSession(row: PreviewSessionRow): Promise<void>;
    getSession(sessionHash: string): Promise<PreviewSessionRow | null>;
    closeSessionsOf(previewId: string, at: string): Promise<number>;
    /** The edge's traffic on a preview (at most once a minute per preview): renews nothing by itself. */
    recordActivity(previewId: string, at: string): Promise<void>;
    /** A viewer asked for a sleeping or blocked preview: the worker's next tick wakes it. */
    requestWake(previewId: string, at: string): Promise<boolean>;
}

/** A certificate serial as both the hub and Node may print it: upper case hex, no colons, no leading zeros. */
export const normalizedSerial = (s: string) => s.replace(/:/g, '').toUpperCase().replace(/^0+(?=.)/, '');
export const sessionHashOf = (cookie: string) => createHash('sha256').update(cookie).digest('hex');

export const OPEN_STATES: readonly PreviewState[] = ['starting', 'ready', 'sleeping', 'blocked'];

const COLUMNS: Record<keyof PreviewRow, string> = {
    previewId: 'preview_id',
    organizationId: 'org_id',
    environmentId: 'environment_id',
    repositoryId: 'repository_id',
    repositoryFullName: 'repository_full_name',
    runId: 'run_id',
    prNumber: 'pr_number',
    side: 'side',
    sha: 'sha',
    host: 'host',
    state: 'state',
    reason: 'reason',
    openedBy: 'opened_by',
    withoutSecrets: 'without_secrets',
    forkPullRequest: 'fork_pull_request',
    idleMinutes: 'idle_minutes',
    ceilingMinutes: 'ceiling_minutes',
    monthlyMachineMinutes: 'monthly_machine_minutes',
    starts: 'starts',
    claimId: 'claim_id',
    cellId: 'cell_id',
    target: 'target_service',
    leaseExpiresAt: 'lease_expires_at',
    claimHardExpiresAt: 'claim_hard_expires_at',
    sealedRepoToken: 'sealed_repo_token',
    tokenSealedAt: 'token_sealed_at',
    wakeRequestedAt: 'wake_requested_at',
    lastActivityAt: 'last_activity_at',
    readyAt: 'ready_at',
    routedAt: 'routed_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    expiresAt: 'expires_at',
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? undefined : String(v));

function rowOf(x: Record<string, unknown>): PreviewRow {
    const opt = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);
    const row: PreviewRow = {
        previewId: String(x.preview_id),
        organizationId: String(x.org_id),
        environmentId: String(x.environment_id),
        repositoryId: String(x.repository_id),
        repositoryFullName: String(x.repository_full_name),
        side: x.side as PreviewSide,
        sha: String(x.sha),
        host: String(x.host),
        state: x.state as PreviewState,
        openedBy: String(x.opened_by),
        withoutSecrets: x.without_secrets !== false,
        forkPullRequest: x.fork_pull_request === true,
        starts: Number(x.starts ?? 0),
        createdAt: iso(x.created_at)!,
        updatedAt: iso(x.updated_at)!,
        expiresAt: iso(x.expires_at)!,
    };
    const int = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
    const extra: Partial<PreviewRow> = {
        runId: opt(x.run_id as string | null),
        prNumber: int(x.pr_number),
        idleMinutes: int(x.idle_minutes),
        ceilingMinutes: int(x.ceiling_minutes),
        monthlyMachineMinutes: int(x.monthly_machine_minutes),
        reason: opt(x.reason as string | null),
        claimId: opt(x.claim_id as string | null),
        cellId: opt(x.cell_id as string | null),
        target: x.target_service ? { service: String(x.target_service), port: Number(x.target_port) } : undefined,
        leaseExpiresAt: iso(x.lease_expires_at),
        claimHardExpiresAt: iso(x.claim_hard_expires_at),
        sealedRepoToken: opt(x.sealed_repo_token as string | null),
        tokenSealedAt: iso(x.token_sealed_at),
        wakeRequestedAt: iso(x.wake_requested_at),
        lastActivityAt: iso(x.last_activity_at),
        readyAt: iso(x.ready_at),
        routedAt: iso(x.routed_at),
    };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = v;
    return row;
}

/** Column/value pairs of a patch; `target` is two columns, undefined clears a column. */
function assignments(patch: PreviewPatch, hasKey: (k: string) => boolean): Array<[string, unknown]> {
    const out: Array<[string, unknown]> = [];
    for (const key of Object.keys(patch) as Array<keyof PreviewPatch>) {
        if (!hasKey(key)) continue;
        const v = patch[key];
        if (key === 'target') {
            const t = v as PreviewRow['target'];
            out.push(['target_service', t?.service ?? null], ['target_port', t?.port ?? null]);
            continue;
        }
        out.push([COLUMNS[key as keyof PreviewRow], v ?? null]);
    }
    return out;
}

export class PgPreviewStore implements PreviewStore {
    constructor(private readonly pool: Pool) {}

    async insertPreview(row: PreviewRow) {
        const cols = assignments(row as PreviewPatch, () => true);
        cols.unshift(['preview_id', row.previewId], ['org_id', row.organizationId], ['environment_id', row.environmentId], ['repository_id', row.repositoryId], ['run_id', row.runId ?? null], ['pr_number', row.prNumber ?? null], ['side', row.side], ['host', row.host], ['created_at', row.createdAt]);
        const seen = new Set<string>();
        const unique = cols.filter(([c]) => (seen.has(c) ? false : (seen.add(c), true)));
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_previews (${unique.map(([c]) => c).join(', ')}) VALUES (${unique.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`,
            unique.map(([, v]) => v),
        );
        return (r.rowCount ?? 0) > 0;
    }

    async getPreview(organizationId: string, previewId: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_previews WHERE preview_id = $1 AND org_id = $2`, [previewId, organizationId]);
        return r.rows[0] ? rowOf(r.rows[0]) : null;
    }

    async updatePreview(organizationId: string, previewId: string, patch: PreviewPatch, from?: readonly PreviewState[]) {
        const cols = assignments(patch, (k) => k in patch);
        if (!cols.length) return true;
        const params: unknown[] = [previewId, organizationId, ...cols.map(([, v]) => v)];
        const set = cols.map(([c], i) => `${c} = $${i + 3}`).join(', ');
        let where = `preview_id = $1 AND org_id = $2`;
        if (from) {
            params.push([...from]);
            where += ` AND state = ANY($${params.length}::text[])`;
        }
        const r = await this.pool.query(`UPDATE runtime.runtime_previews SET ${set} WHERE ${where}`, params);
        return (r.rowCount ?? 0) > 0;
    }

    async listOpenPreviews(limit: number) {
        const r = await this.pool.query(
            `SELECT * FROM runtime.runtime_previews WHERE state IN ('starting', 'ready', 'sleeping', 'blocked') ORDER BY updated_at LIMIT $1`,
            [limit],
        );
        return r.rows.map(rowOf);
    }

    async tunnelHeld(cellId: string, since: string) {
        const r = await this.pool.query(`SELECT 1 FROM runtime.runtime_preview_tunnels WHERE cell_id = $1 AND seen_at >= $2`, [cellId, since]);
        return (r.rowCount ?? 0) > 0;
    }

    async openPreviewsOfPullRequest(organizationId: string, repositoryId: string, prNumber: number) {
        const r = await this.pool.query(
            `SELECT * FROM runtime.runtime_previews WHERE org_id = $1 AND repository_id = $2 AND pr_number = $3 AND state IN ('starting', 'ready', 'sleeping', 'blocked') LIMIT 100`,
            [organizationId, repositoryId, prNumber],
        );
        return r.rows.map(rowOf);
    }

    async openEnvironmentPreviews(organizationId: string, environmentId: string) {
        const r = await this.pool.query(
            `SELECT * FROM runtime.runtime_previews WHERE org_id = $1 AND environment_id = $2 AND run_id IS NULL AND state IN ('starting', 'ready', 'sleeping', 'blocked') LIMIT 100`,
            [organizationId, environmentId],
        );
        return r.rows.map(rowOf);
    }

    async securityViolations(claims: ReadonlyArray<{ organizationId: string; claimId: string }>) {
        const out = new Map<string, string>();
        if (!claims.length) return out;
        const r = await this.pool.query(
            `SELECT b.claim_id, b.signature FROM runtime.runtime_claim_blockers b
               JOIN unnest($1::text[], $2::text[]) AS c(org_id, claim_id) ON c.org_id = b.org_id AND c.claim_id = b.claim_id
              WHERE b.kind = 'security_violation' ORDER BY b.at`,
            [claims.map((c) => c.organizationId), claims.map((c) => c.claimId)],
        );
        for (const row of r.rows) if (!out.has(row.claim_id)) out.set(String(row.claim_id), String(row.signature ?? 'unknown'));
        return out;
    }

    async previewClaimsSince(organizationId: string, since: string) {
        // runtime_claims_org_created_idx (migration 23); a month of one org's previews is small.
        const r = await this.pool.query(
            `SELECT claim_id, cell_id, side, state, driver, memory_mb_boot, memory_mb_ready, memory_allocatable_mb, cpus,
                    admitted_at, ready_at, released_at, state_changed_at, hard_expires_at
               FROM runtime.runtime_claims WHERE org_id = $1 AND created_at >= $2 AND consumer = 'preview' LIMIT 10000`,
            [organizationId, since],
        );
        return r.rows.map(
            (x): RunClaimUsage => ({
                claimId: String(x.claim_id),
                cellId: String(x.cell_id),
                side: String(x.side),
                state: String(x.state),
                driver: x.driver ?? null,
                bootMb: x.memory_mb_boot ?? null,
                readyMb: x.memory_mb_ready ?? null,
                allocatableMb: x.memory_allocatable_mb ?? null,
                cpus: x.cpus ?? null,
                admittedAt: iso(x.admitted_at) ?? null,
                readyAt: iso(x.ready_at) ?? null,
                releasedAt: iso(x.released_at) ?? null,
                stateChangedAt: iso(x.state_changed_at) ?? null,
                hardExpiresAt: iso(x.hard_expires_at) ?? null,
            }),
        );
    }

    async audit(e: PreviewAuditEntry) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_preview_audit (at, org_id, preview_id, run_id, side, actor, action, reason, requests, bytes_in, bytes_out)
             VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [e.at ?? null, e.organizationId, e.previewId, e.runId ?? null, e.side ?? null, e.actor ?? null, e.action, e.reason ?? null, e.requests ?? null, e.bytesIn ?? null, e.bytesOut ?? null],
        );
    }

    async insertTunnelTicket(ticketHash: string, cellId: string, expiresAt: string) {
        await this.pool.query(`INSERT INTO runtime.runtime_preview_tunnel_tickets (ticket_hash, cell_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [ticketHash, cellId, expiresAt]);
    }

    async previewByHost(host: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_previews WHERE host = $1`, [host.toLowerCase()]);
        return r.rows[0] ? rowOf(r.rows[0]) : null;
    }

    async consumeTunnelTicket(ticketHash: string, cellId: string, now: string) {
        const r = await this.pool.query(`DELETE FROM runtime.runtime_preview_tunnel_tickets WHERE ticket_hash = $1 RETURNING cell_id, expires_at`, [ticketHash]);
        const t = r.rows[0];
        return !!t && t.cell_id === cellId && iso(t.expires_at)! > now;
    }

    async cellCertificatePinned(cellId: string, serial: string, now: string) {
        const r = await this.pool.query(`SELECT status, certificate_serial, certificate_expires_at FROM runtime.runtime_cells WHERE cell_id = $1`, [cellId]);
        const c = r.rows[0];
        if (!c || c.status === 'revoked' || !c.certificate_serial) return false;
        if (c.certificate_expires_at && iso(c.certificate_expires_at)! <= now) return false;
        return normalizedSerial(String(c.certificate_serial)) === normalizedSerial(serial);
    }

    async holdTunnel(cellId: string, replica: string, now: string, url?: string) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_preview_tunnels (cell_id, edge_replica, connected_at, seen_at, edge_url) VALUES ($1, $2, $3, $3, $4)
             ON CONFLICT (cell_id) DO UPDATE SET edge_replica = EXCLUDED.edge_replica, seen_at = EXCLUDED.seen_at, edge_url = EXCLUDED.edge_url,
               connected_at = CASE WHEN runtime.runtime_preview_tunnels.edge_replica = EXCLUDED.edge_replica THEN runtime.runtime_preview_tunnels.connected_at ELSE EXCLUDED.connected_at END`,
            [cellId, replica, now, url ?? null],
        );
    }

    async tunnelHolder(cellId: string, since: string) {
        const r = await this.pool.query(`SELECT edge_replica, edge_url FROM runtime.runtime_preview_tunnels WHERE cell_id = $1 AND seen_at >= $2`, [cellId, since]);
        const t = r.rows[0];
        return t ? { replica: String(t.edge_replica), ...(t.edge_url ? { url: String(t.edge_url) } : {}) } : null;
    }

    async releaseTunnel(cellId: string, replica: string) {
        await this.pool.query(`DELETE FROM runtime.runtime_preview_tunnels WHERE cell_id = $1 AND edge_replica = $2`, [cellId, replica]);
    }

    async useGrant(jti: string, expiresAt: string) {
        const r = await this.pool.query(`INSERT INTO runtime.runtime_preview_grants_used (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [jti, expiresAt]);
        return (r.rowCount ?? 0) > 0;
    }

    async createSession(s: PreviewSessionRow) {
        await this.pool.query(
            `INSERT INTO runtime.runtime_preview_sessions (session_hash, preview_id, org_id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
            [s.sessionHash, s.previewId, s.organizationId, s.userId, s.createdAt, s.expiresAt],
        );
    }

    async getSession(sessionHash: string) {
        const r = await this.pool.query(`SELECT * FROM runtime.runtime_preview_sessions WHERE session_hash = $1`, [sessionHash]);
        const x = r.rows[0];
        if (!x) return null;
        return {
            sessionHash: x.session_hash,
            previewId: x.preview_id,
            organizationId: x.org_id,
            userId: x.user_id,
            createdAt: iso(x.created_at)!,
            expiresAt: iso(x.expires_at)!,
            ...(x.closed_at ? { closedAt: iso(x.closed_at)! } : {}),
        };
    }

    async closeSessionsOf(previewId: string, at: string) {
        const r = await this.pool.query(`UPDATE runtime.runtime_preview_sessions SET closed_at = $2 WHERE preview_id = $1 AND closed_at IS NULL`, [previewId, at]);
        return r.rowCount ?? 0;
    }

    async recordActivity(previewId: string, at: string) {
        await this.pool.query(
            `UPDATE runtime.runtime_previews SET last_activity_at = $2 WHERE preview_id = $1 AND (last_activity_at IS NULL OR last_activity_at < $2)`,
            [previewId, at],
        );
    }

    async requestWake(previewId: string, at: string) {
        const r = await this.pool.query(`UPDATE runtime.runtime_previews SET wake_requested_at = $2 WHERE preview_id = $1 AND state IN ('sleeping', 'blocked')`, [previewId, at]);
        return (r.rowCount ?? 0) > 0;
    }
}
