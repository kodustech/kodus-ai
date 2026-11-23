// Test doubles (libs/runtime/AGENTS.md): specs and dev wiring import them, production code never does.
import { KODUS_STATIC_POOL_ID, orgDefaultPoolId } from '@libs/runtime/fleet/pool';
import { CellTokenLedger } from '@libs/runtime/contracts/cell-token';
import { ORG_EGRESS_SCOPE } from '@libs/runtime/contracts/egress';
import { assertClaimTransition, type ClaimState, LIVE_CLAIM_STATES, REBINDABLE_CLAIM_STATES } from '@libs/runtime/contracts/enums';
import { InMemoryCellTokenStore, InMemoryFleetTokenStore } from '@libs/runtime/contracts/testing';
import { FleetTokenLedger } from '@libs/runtime/contracts/fleet-token';
import { SANDBOX_ENVIRONMENT_ID } from '@libs/runtime/protocol/sandbox';

import { BAKE_ASK_TTL_MS, PIN_EXPIRY_MARGIN_HOURS, type BakeAskRow, type CellSession, type ClaimBlockerRow, type ClaimCause, type ClaimMetering, type ClaimRow, type EvictedBuildStateRow, type HubStore, type RegisteredCell, type SandboxAuditRow, SHARED_IMAGE_BAKES_KEPT, type SharedBakeRecord, type StepRow } from './hub-store';

export class InMemoryHubStore implements HubStore {
    readonly sessions = new Map<string, CellSession & { connected: boolean; lastHeartbeatAt: number; freeSlots: number }>();
    readonly claims = new Map<string, ClaimRow>();
    readonly steps = new Map<string, StepRow & { finished?: boolean }>();
    readonly egress: Array<{ claimId: string; cellId: string; orgId: string; host: string; port: number; phase: string; at: string }> = [];
    readonly cells = new Map<string, RegisteredCell>();
    readonly approvals = new Map<string, string[]>();
    readonly blockers: ClaimBlockerRow[] = [];
    readonly evictions = new Map<string, EvictedBuildStateRow[]>();
    readonly bakeAsks: BakeAskRow[] = [];
    readonly sharedRows: Array<{ orgId: string; environmentId: string; fingerprint: string; digest: string; cellId: string; askedAt: string; pushedAt: string }> = [];
    private readonly managedSerials = new Map<string, string>();
    readonly ledger: CellTokenLedger;
    readonly fleetLedger: FleetTokenLedger;
    readonly hostPools = new Map<string, { provider: string; lifecycle: string }>();
    readonly revokedCells: string[] = [];

    constructor(opts: { ledger?: CellTokenLedger; fleetLedger?: FleetTokenLedger } = {}) {
        this.ledger = opts.ledger ?? new CellTokenLedger(new InMemoryCellTokenStore());
        this.fleetLedger = opts.fleetLedger ?? new FleetTokenLedger(new InMemoryFleetTokenStore());
    }

    async upsertSession(s: CellSession) {
        const prev = this.sessions.get(s.cellId);
        this.sessions.set(s.cellId, { ...s, connected: true, lastHeartbeatAt: Date.now(), freeSlots: prev?.freeSlots ?? 0 });
        const c = this.cells.get(s.cellId);
        if (c && c.status !== 'revoked') c.status = 'connected';
    }
    async heartbeat(cellId: string, replicaId: string, freeSlots: number,
        sessionEpoch?: string,
        memory?: { allocatableMb: number; committedMb: number },
        sandboxPool?: { target: number; ready: number },
    ) {
        const s = this.sessions.get(cellId);
        if (s && s.replicaId === replicaId &&
            (!sessionEpoch || s.sessionEpoch === sessionEpoch)
        ) Object.assign(s, { lastHeartbeatAt: Date.now(), freeSlots }, memory ? { memory: { ...memory } } : {}, sandboxPool ? { sandboxPool: { ...sandboxPool } } : {});
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
        this.claims.set(c.claimId, { ...c, forkPullRequest: c.forkPullRequest === true, reason: 'acquired', reasonDetail: null, stateChangedAt: now, admittedAt: now, readyAt: null, releasedAt: null });
        return true;
    }
    async claim(claimId: string) {
        const c = this.claims.get(claimId);
        return c ? { ...c } : null;
    }
    async transitionClaim(claimId: string, from: readonly ClaimState[], to: ClaimState, cause: ClaimCause) {
        assertClaimTransition(from, to);
        const c = this.claims.get(claimId);
        if (!c || !from.includes(c.state)) return false;
        const now = new Date().toISOString();
        Object.assign(c, {
            state: to,
            reason: cause.reason,
            reasonDetail: cause.detail ?? null,
            stateChangedAt: now,
            readyAt: cause.reason === 'ready' ? now : (c.readyAt ?? null),
            start: cause.reason === 'ready' ? (cause.start ?? null) : (c.start ?? null),
            releasedAt: to === 'released' || to === 'terminated' ? now : (c.releasedAt ?? null),
        });
        return true;
    }
    async rebindClaim(claimId: string, n: { cellId: string; leaseExpiresAt: string; hardExpiresAt: string; metering?: ClaimMetering | null }) {
        const c = this.claims.get(claimId);
        if (!c || !REBINDABLE_CLAIM_STATES.includes(c.state)) return false;
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
            start: null,
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
    async syncEvictedBuildStates(cellId: string, rows: EvictedBuildStateRow[]) {
        this.evictions.set(cellId, rows.map((r) => ({ ...r })));
    }
    async evictedBuildStateAt(cellId: string, orgId: string, environmentId: string) {
        return (await this.evictedBuildState(cellId, orgId, environmentId))?.evictedAt ?? null;
    }
    async evictedBuildState(cellId: string, orgId: string, environmentId: string) {
        const row = this.evictions.get(cellId)?.find((r) => r.orgId === orgId && r.environmentId === environmentId);
        return row ? { ...row } : null;
    }
    async recordBakeAsk(a: BakeAskRow) {
        const i = this.bakeAsks.findIndex((x) => x.cellId === a.cellId && x.orgId === a.orgId && x.environmentId === a.environmentId && x.envKey === a.envKey && x.recipeSha === a.recipeSha);
        if (i >= 0) this.bakeAsks.splice(i, 1);
        this.bakeAsks.push({ ...a });
    }
    async recordSharedImages(r: SharedBakeRecord) {
        const ask = this.bakeAsks.find(
            (x) => x.cellId === r.cellId && x.orgId === r.orgId && x.environmentId === r.environmentId && x.envKey === r.envKey && x.recipeSha === r.recipeSha && Date.parse(x.askedAt) > Date.parse(r.pushedAt) - BAKE_ASK_TTL_MS,
        );
        if (!ask) return 'not_asked' as const;
        for (const img of r.images) {
            const i = this.sharedRows.findIndex((x) => x.orgId === r.orgId && x.environmentId === r.environmentId && x.fingerprint === img.fingerprint);
            if (i >= 0 && Date.parse(this.sharedRows[i].askedAt) > Date.parse(ask.askedAt)) continue;
            if (i >= 0) this.sharedRows.splice(i, 1);
            this.sharedRows.push({ orgId: r.orgId, environmentId: r.environmentId, fingerprint: img.fingerprint, digest: img.digest, cellId: r.cellId, askedAt: ask.askedAt, pushedAt: r.pushedAt });
        }
        const env = this.sharedRows.filter((x) => x.orgId === r.orgId && x.environmentId === r.environmentId);
        const kept = [...new Set(env.map((x) => x.askedAt))].sort((a, b) => Date.parse(b) - Date.parse(a)).slice(0, SHARED_IMAGE_BAKES_KEPT);
        for (const x of env) if (!kept.includes(x.askedAt)) this.sharedRows.splice(this.sharedRows.indexOf(x), 1);
        return 'recorded' as const;
    }
    async sharedImages(orgId: string, environmentId: string, limit: number) {
        return this.sharedRows
            .filter((x) => x.orgId === orgId && x.environmentId === environmentId)
            .sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt) || (a.fingerprint < b.fingerprint ? -1 : 1))
            .slice(0, limit)
            .map((x) => ({ fingerprint: x.fingerprint, digest: x.digest }));
    }
    async removeSharedImages(orgId: string, environmentId: string) {
        const before = this.sharedRows.length;
        for (let i = this.sharedRows.length - 1; i >= 0; i--) if (this.sharedRows[i].orgId === orgId && this.sharedRows[i].environmentId === environmentId) this.sharedRows.splice(i, 1);
        return before - this.sharedRows.length;
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
        return (await this.approvedEgress(orgId, environmentId)).allow;
    }
    /** The hosts approved as inspected, by `${org}/${env}`, with their paths; a host here is in approvals too. */
    readonly inspectedApprovals = new Map<string, Array<{ host: string; paths: string[] }>>();
    readonly egressSettings = new Map<string, boolean>();
    readonly egressSent: Array<{ orgId: string; environmentId: string; hosts: string[] }> = [];
    async approvedEgress(orgId: string, environmentId: string) {
        const scopes = environmentId === SANDBOX_ENVIRONMENT_ID ? [environmentId] : [environmentId, ORG_EGRESS_SCOPE];
        const allow = [...new Set(scopes.flatMap((s) => this.approvals.get(`${orgId}/${s}`) ?? []).map((h) => h.toLowerCase()))].sort();
        const inspect = scopes.flatMap((s) => this.inspectedApprovals.get(`${orgId}/${s}`) ?? []).filter((r) => allow.includes(r.host));
        return { allow, inspect: [...new Map(inspect.map((r) => [r.host, r])).values()].sort((a, b) => a.host.localeCompare(b.host)) };
    }
    async egressRecommendedEnabled(orgId: string) {
        return this.egressSettings.get(orgId) ?? true;
    }
    async markEgressSent(orgId: string, environmentId: string, hosts: string[]) {
        this.egressSent.push({ orgId, environmentId, hosts: [...hosts] });
    }
    async liveClaimsOfOrganization(orgId: string) {
        return [...this.claims.values()].filter((c) => c.orgId === orgId && c.state === 'bound');
    }
    readonly sandboxAudit: SandboxAuditRow[] = [];
    async recordSandboxAudit(r: SandboxAuditRow) {
        this.sandboxAudit.push({ ...r });
    }
    async registeredCell(cellId: string) {
        return this.cells.get(cellId) ?? null;
    }
    async redeemAndRegister(token: string, topology: string | undefined, cell: (r: { organizationId: string; topology: string }) => RegisteredCell) {
        const r = await this.ledger.redeem(token, topology);
        if (r.ok) {
            const row = cell(r);
            // As PgHubStore: an org token binds the org's default static pool unless the row names one.
            this.cells.set(row.cellId, { ...row, poolId: row.poolId ?? orgDefaultPoolId(r.organizationId) });
        }
        return r;
    }
    async redeemFleetAndRegister(token: string, cell: (r: { poolId: string; hostId: string; boundKey: string | null }) => RegisteredCell) {
        const r = await this.fleetLedger.redeem(token);
        if (r.ok) {
            const row = cell(r);
            this.cells.set(row.cellId, { ...row, organizationId: null, owner: 'kodus', topology: 'fleet', poolId: r.poolId, hostId: r.hostId, boundKey: r.boundKey });
        }
        return r;
    }
    async hostPool(poolId: string) {
        return this.hostPools.get(poolId) ?? null;
    }
    async fleetHostCell(hostId: string) {
        const c = [...this.cells.values()].find((x) => x.hostId === hostId && x.topology === 'fleet');
        return c ? { cellId: c.cellId, boundKey: c.boundKey ?? null, connected: c.status === 'connected' } : null;
    }
    async retireHostCell(hostId: string) {
        const c = [...this.cells.values()].find((x) => x.hostId === hostId && x.topology === 'fleet');
        if (!c) return null;
        c.status = 'revoked';
        this.revokedCells.push(c.cellId);
        return c.cellId;
    }
    async filterRevoked(cellIds: string[]) {
        return cellIds.filter((id) => this.cells.get(id)?.status === 'revoked');
    }
    async filterExpired(cellIds: string[], at: string) {
        return cellIds.filter((id) => {
            const c = this.cells.get(id);
            return !!c?.certificateExpiresAt && Date.parse(c.certificateExpiresAt) <= Date.parse(at);
        });
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
        this.cells.set(m.cellId, { cellId: m.cellId, organizationId: null, owner: 'kodus', topology: 'managed', status: c?.status ?? 'disconnected', poolId: KODUS_STATIC_POOL_ID, ...m });
    }
    async cellPins() {
        const since = Date.now() - PIN_EXPIRY_MARGIN_HOURS * 3_600_000;
        return [...this.cells.values()]
            .filter((c) => !c.certificateExpiresAt || Date.parse(c.certificateExpiresAt) > since)
            .map((c) => ({ cellId: c.cellId, serial: c.certificateSerial, status: c.status }));
    }
}
