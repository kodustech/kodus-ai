// Test doubles (libs/runtime/AGENTS.md): specs and dev wiring import them, production code never does.
import type { CellTokenRecord } from '@libs/runtime/contracts/cell-token';
import type { PreviewState } from '@libs/runtime/contracts/preview';
import type { RunClaimUsage } from '@libs/runtime/api/domain/run-cost';

import type { DistributedLocks } from './locks';
import { type CommandStore, type EgressApprovalRecord, type EgressAuditRecord, egressScopes } from './pg-command-store';
import { normalizedSerial, OPEN_STATES, type PreviewAuditEntry, type PreviewPatch, type PreviewRow, type PreviewSessionRow, type PreviewStore } from './preview-store';
import { type PlacedSession, type PullRequestRef, SESSION, sessionRef, type SnapshotPlacements } from './snapshot-placements';

/** One process: a promise chain per key (unit tests, the in-memory stack). */
export class InMemoryDistributedLocks implements DistributedLocks {
    private readonly chains = new Map<string, Promise<unknown>>();
    private readonly held = new Set<string>();

    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.chains.get(key) ?? Promise.resolve();
        // A failed holder releases the lock for the next one; its caller already got the rejection.
        const run = prev.catch(() => undefined).then(async () => {
            this.held.add(key);
            try {
                return await fn();
            } finally {
                this.held.delete(key);
            }
        });
        // The chain only orders the holders; `run` itself goes back to the caller with its rejection.
        this.chains.set(key, run.catch(() => undefined));
        return run;
    }

    async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
        if (this.held.has(key)) return undefined;
        return this.withLock(key, fn);
    }
}

export class InMemoryCommandStore implements CommandStore {
    approvals: any[] = [];
    egress: any[] = [];
    stops: any[] = [];
    tokens: CellTokenRecord[] = [];
    revoked: any[] = [];
    async recordForkApproval(a: any) {
        if (!this.approvals.some((x) => x.key === a.key)) this.approvals.push(a);
    }
    async hasForkApproval(runId: string, headSha: string) {
        return this.approvals.some((a) => a.runId === runId && a.headSha === headSha);
    }
    egressAudit: EgressAuditRecord[] = [];
    egressSettings = new Map<string, { recommendedEnabled: boolean; whoMayAdd: string; updatedAt: string }>();
    machineMinuteLimits = new Map<string, { minutesPerDay: number | null; updatedAt: string }>();
    async recordEgressApproval(a: EgressApprovalRecord) {
        const same = (e: any) => e.organizationId === a.organizationId && e.environmentId === a.environmentId && e.host === a.host.toLowerCase();
        const old = this.egress.find(same);
        if (old && (old.approvedAt > a.approvedAt || (old.revokedAt && old.revokedAt > a.approvedAt))) return;
        this.egress = this.egress.filter((e) => !same(e));
        this.egress.push({ ...a, host: a.host.toLowerCase(), mode: a.mode ?? 'passthrough' });
    }
    async revokeEgressApproval(r: { environmentId: string; host: string; organizationId: string; revokedBy: string; revokedAt: string }) {
        const row = this.egress.find((e) => e.organizationId === r.organizationId && e.environmentId === r.environmentId && e.host === r.host.toLowerCase() && !e.revokedAt && e.approvedAt <= r.revokedAt);
        if (!row) return false;
        row.revokedAt = r.revokedAt;
        row.revokedBy = r.revokedBy;
        return true;
    }
    async recordEgressAudit(a: EgressAuditRecord) {
        if (!this.egressAudit.some((x) => x.key === a.key)) this.egressAudit.push(a);
    }
    async recordEgressSettings(s: { organizationId: string; recommendedEnabled: boolean; whoMayAdd: string; updatedBy: string; updatedAt: string }) {
        const old = this.egressSettings.get(s.organizationId);
        if (old && old.updatedAt > s.updatedAt) return;
        this.egressSettings.set(s.organizationId, s);
    }
    async recordMachineMinuteLimit(s: { organizationId: string; minutesPerDay: number | null; updatedBy: string; updatedAt: string }) {
        const old = this.machineMinuteLimits.get(s.organizationId);
        if (old && old.updatedAt > s.updatedAt) return;
        this.machineMinuteLimits.set(s.organizationId, { minutesPerDay: s.minutesPerDay, updatedAt: s.updatedAt });
    }
    async machineMinuteLimit(organizationId: string) {
        return this.machineMinuteLimits.get(organizationId)?.minutesPerDay ?? null;
    }
    async approvedHosts(orgId: string, envId: string) {
        const scopes = egressScopes(envId);
        return [...new Set(this.egress.filter((e) => e.organizationId === orgId && scopes.includes(e.environmentId) && !e.revokedAt).map((e) => String(e.host).toLowerCase()))].sort();
    }
    async recordStop(s: any) {
        this.stops.push(s);
    }
    async isStopped(orgId: string) {
        return this.stops.some((s) => !s.clearedAt && (s.scope === 'global' || s.organizationId === orgId));
    }
    async clearStop(c: { scope: 'org' | 'global'; organizationId?: string; clearedAt: string }) {
        let n = 0;
        for (const s of this.stops) {
            const inScope = s.scope === c.scope && (c.scope === 'global' || s.organizationId === c.organizationId);
            if (inScope && !s.clearedAt && Date.parse(s.requestedAt) <= Date.parse(c.clearedAt)) {
                s.clearedAt = c.clearedAt;
                n++;
            }
        }
        return n;
    }
    async recordCellToken(t: CellTokenRecord) {
        this.tokens.push(t);
    }
    async revokeCellToken(r: { tokenHash: string; organizationId: string; revokedAt: string }) {
        const t = this.tokens.find((x) => x.tokenHash === r.tokenHash && x.organizationId === r.organizationId && !x.usedAt && !x.revokedAt);
        if (t) t.revokedAt = r.revokedAt;
        return !!t;
    }
    async revokeCell(r: any) {
        this.revoked.push(r);
    }
}

/** For tests and the local demo. */
export class InMemorySnapshotPlacements implements SnapshotPlacements {
    readonly cells = new Map<string, string>();
    readonly prs = new Map<string, PullRequestRef>();
    async record(orgId: string, ref: string, cellId: string, pullRequest?: PullRequestRef): Promise<void> {
        this.cells.set(`${orgId}\0${ref}`, cellId);
        if (pullRequest) this.prs.set(`${orgId}\0${ref}`, pullRequest);
        else this.prs.delete(`${orgId}\0${ref}`);
    }
    async cellOf(orgId: string, ref: string): Promise<string | undefined> {
        return this.cells.get(`${orgId}\0${ref}`);
    }
    async sessionsOf(orgId: string, pr: PullRequestRef): Promise<PlacedSession[]> {
        const out: PlacedSession[] = [];
        for (const [k, p] of this.prs) {
            const [org, ref] = k.split('\0');
            if (org === orgId && ref.startsWith(SESSION) && p.repositoryId === pr.repositoryId && p.prNumber === pr.prNumber) {
                out.push({ snapshotId: ref.slice(SESSION.length), cellId: this.cells.get(k)! });
            }
        }
        return out;
    }
    async forget(orgId: string, snapshotIds: string[]): Promise<void> {
        for (const id of snapshotIds) {
            this.cells.delete(`${orgId}\0${sessionRef(id)}`);
            this.prs.delete(`${orgId}\0${sessionRef(id)}`);
        }
    }
}

export class InMemoryPreviewStore implements PreviewStore {
    readonly previews = new Map<string, PreviewRow>();
    readonly sessions = new Map<string, PreviewSessionRow>();
    readonly grants = new Map<string, string>();
    readonly tickets = new Map<string, { cellId: string; expiresAt: string }>();
    readonly tunnels = new Map<string, { replica: string; seenAt: string; url?: string }>();
    readonly audits: PreviewAuditEntry[] = [];
    /** claimId → the security_violation its cell reported (tests set it). */
    readonly violations = new Map<string, { organizationId: string; signature: string }>();
    readonly claims: Array<RunClaimUsage & { organizationId: string; consumer: string; createdAt: string }> = [];
    /** cellId → pinned serial (tests set it). */
    readonly pins = new Map<string, string>();

    async insertPreview(row: PreviewRow) {
        if (this.previews.has(row.previewId) || [...this.previews.values()].some((p) => p.host === row.host)) return false;
        this.previews.set(row.previewId, structuredClone(row));
        return true;
    }
    async getPreview(organizationId: string, previewId: string) {
        const r = this.previews.get(previewId);
        return r && r.organizationId === organizationId ? structuredClone(r) : null;
    }
    async updatePreview(organizationId: string, previewId: string, patch: PreviewPatch, from?: readonly PreviewState[]) {
        const r = this.previews.get(previewId);
        if (!r || r.organizationId !== organizationId || (from && !from.includes(r.state))) return false;
        const next = { ...r } as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete next[k];
            else next[k] = v;
        }
        this.previews.set(previewId, structuredClone(next as unknown as PreviewRow));
        return true;
    }
    async listOpenPreviews(limit: number) {
        return [...this.previews.values()]
            .filter((p) => OPEN_STATES.includes(p.state))
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            .slice(0, limit)
            .map((p) => structuredClone(p));
    }
    async tunnelHeld(cellId: string, since: string) {
        const t = this.tunnels.get(cellId);
        return !!t && t.seenAt >= since;
    }
    async audit(entry: PreviewAuditEntry) {
        this.audits.push({ ...entry, at: entry.at ?? new Date().toISOString() });
    }
    async openPreviewsOfPullRequest(organizationId: string, repositoryId: string, prNumber: number) {
        return [...this.previews.values()]
            .filter((p) => p.organizationId === organizationId && p.repositoryId === repositoryId && p.prNumber === prNumber && OPEN_STATES.includes(p.state))
            .map((p) => structuredClone(p));
    }
    async openEnvironmentPreviews(organizationId: string, environmentId: string) {
        return [...this.previews.values()]
            .filter((p) => p.organizationId === organizationId && p.environmentId === environmentId && !p.runId && OPEN_STATES.includes(p.state))
            .map((p) => structuredClone(p));
    }
    async securityViolations(claims: ReadonlyArray<{ organizationId: string; claimId: string }>) {
        const out = new Map<string, string>();
        for (const c of claims) {
            const v = this.violations.get(c.claimId);
            if (v && v.organizationId === c.organizationId) out.set(c.claimId, v.signature);
        }
        return out;
    }
    async previewClaimsSince(organizationId: string, since: string) {
        return this.claims.filter((c) => c.organizationId === organizationId && c.consumer === 'preview' && c.createdAt >= since).map((c) => ({ ...c }));
    }
    async insertTunnelTicket(ticketHash: string, cellId: string, expiresAt: string) {
        this.tickets.set(ticketHash, { cellId, expiresAt });
    }
    async previewByHost(host: string) {
        const r = [...this.previews.values()].find((p) => p.host === host.toLowerCase());
        return r ? structuredClone(r) : null;
    }
    async consumeTunnelTicket(ticketHash: string, cellId: string, now: string) {
        const t = this.tickets.get(ticketHash);
        this.tickets.delete(ticketHash);
        return !!t && t.cellId === cellId && t.expiresAt > now;
    }
    async cellCertificatePinned(cellId: string, serial: string) {
        const pin = this.pins.get(cellId);
        return !!pin && normalizedSerial(pin) === normalizedSerial(serial);
    }
    async holdTunnel(cellId: string, replica: string, now: string, url?: string) {
        this.tunnels.set(cellId, { replica, seenAt: now, ...(url ? { url } : {}) });
    }
    async tunnelHolder(cellId: string, since: string) {
        const t = this.tunnels.get(cellId);
        return t && t.seenAt >= since ? { replica: t.replica, ...(t.url ? { url: t.url } : {}) } : null;
    }
    async releaseTunnel(cellId: string, replica: string) {
        if (this.tunnels.get(cellId)?.replica === replica) this.tunnels.delete(cellId);
    }
    async useGrant(jti: string, expiresAt: string) {
        if (this.grants.has(jti)) return false;
        this.grants.set(jti, expiresAt);
        return true;
    }
    async createSession(row: PreviewSessionRow) {
        this.sessions.set(row.sessionHash, { ...row });
    }
    async getSession(sessionHash: string) {
        const s = this.sessions.get(sessionHash);
        return s ? { ...s } : null;
    }
    async closeSessionsOf(previewId: string, at: string) {
        let n = 0;
        for (const s of this.sessions.values()) {
            if (s.previewId === previewId && !s.closedAt) {
                s.closedAt = at;
                n++;
            }
        }
        return n;
    }
    async recordActivity(previewId: string, at: string) {
        const r = this.previews.get(previewId);
        if (r && (!r.lastActivityAt || r.lastActivityAt < at)) r.lastActivityAt = at;
    }
    async requestWake(previewId: string, at: string) {
        const r = this.previews.get(previewId);
        if (!r || (r.state !== 'sleeping' && r.state !== 'blocked')) return false;
        r.wakeRequestedAt = at;
        return true;
    }
}
