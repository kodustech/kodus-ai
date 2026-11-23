import type { HostPool } from '@libs/runtime/fleet/pool';

import type { Demand, FleetStore, HostFailure, HostReason, HostRow, HostState, PoolStatus, StoredPool } from './fleet-store';
import type { HubFleetPort, PerRunHostDeps, StepRetry, TemplateResolver } from './per-run-host';
import type { TemplateRow, TemplateStore } from './template/template-store';

// Test doubles of runtime-fleet: the store in memory, a hub that mints and
// registers on cue, a step runner that records outputs like DBOS does and can
// crash, and a clock the durable sleeps move. Specs only.

export class InMemoryFleetStore implements FleetStore {
    readonly pools = new Map<string, StoredPool>();
    readonly demand = new Map<string, Demand & { expiresAt: number; failure?: HostFailure }>();
    readonly hosts = new Map<string, HostRow & { lastError?: string }>();
    readonly events: Array<{ hostId: string; from: HostState | null; to: HostState; reason: HostReason }> = [];
    /** Hosts whose cell registered and is connected. */
    readonly connected = new Set<string>();
    readonly claims = new Map<string, number>();

    constructor(private readonly clock: { now(): number }) {}

    addPool(pool: HostPool, status: PoolStatus = { scalable: true }) {
        const poolId = pool.scope === 'kodus' ? pool.name : `${pool.scope}/${pool.name}`;
        this.pools.set(poolId, { poolId, pool, status });
        return poolId;
    }

    addDemand(d: Omit<Demand, 'hostId'> & { ttlMs?: number }) {
        this.demand.set(`${d.poolId}\n${d.boundKey}`, { ...d, hostId: null, expiresAt: this.clock.now() + (d.ttlMs ?? 120_000) });
    }

    async controlledPools() {
        return { pools: [...this.pools.values()].filter((p) => p.pool.provider !== 'static'), invalid: [] };
    }
    async pool(poolId: string) {
        return this.pools.get(poolId) ?? null;
    }
    async setPoolStatus(poolId: string, status: PoolStatus) {
        const p = this.pools.get(poolId);
        if (p) p.status = { ...p.status, ...status };
    }
    async recordPoolOutcome(poolId: string, outcome: { ok: true } | { ok: false; reason: string }) {
        const p = this.pools.get(poolId);
        if (!p) return;
        p.status =
            outcome.ok === false
                ? { ...p.status, consecutiveFailures: (p.status.consecutiveFailures ?? 0) + 1, lastFailureAt: new Date(this.clock.now()).toISOString(), lastError: outcome.reason }
                : { ...p.status, consecutiveFailures: 0 };
    }
    async openDemand(poolId: string) {
        return [...this.demand.values()].filter((d) => d.poolId === poolId && !d.failure && d.expiresAt > this.clock.now()).map(({ expiresAt: _e, failure: _f, ...d }) => d);
    }
    async claimDemand(poolId: string, boundKey: string, hostId: string) {
        const d = this.demand.get(`${poolId}\n${boundKey}`);
        if (!d || d.hostId) return false;
        d.hostId = hostId;
        return true;
    }
    async demandLive(poolId: string, boundKey: string) {
        const d = this.demand.get(`${poolId}\n${boundKey}`);
        return !!d && !d.failure && d.expiresAt > this.clock.now();
    }
    async failDemand(poolId: string, boundKey: string, failure: HostFailure) {
        const d = this.demand.get(`${poolId}\n${boundKey}`);
        if (d && !d.failure) d.failure = failure;
    }
    async insertHost(h: Omit<HostRow, 'state' | 'providerId'>) {
        if (this.hosts.has(h.hostId)) return;
        this.hosts.set(h.hostId, { ...h, state: 'requested', providerId: null });
        this.events.push({ hostId: h.hostId, from: null, to: 'requested', reason: 'demand' });
    }
    async host(hostId: string) {
        const h = this.hosts.get(hostId);
        return h ? { ...h } : null;
    }
    async moveHost(hostId: string, to: HostState, reason: HostReason, patch: { providerId?: string; lastError?: string } = {}) {
        const h = this.hosts.get(hostId);
        if (!h || h.state === 'terminated' || h.state === to) return;
        this.events.push({ hostId, from: h.state, to, reason });
        h.state = to;
        if (patch.providerId) h.providerId = patch.providerId;
        if (patch.lastError) h.lastError = patch.lastError;
    }
    async liveHosts(poolId?: string) {
        return [...this.hosts.values()].filter((h) => h.state !== 'terminated' && (!poolId || h.poolId === poolId));
    }
    async hostCell(hostId: string) {
        return this.connected.has(hostId) ? { cellId: `cell-of-${hostId}`, connected: true } : null;
    }
    async liveClaimsOnHost(hostId: string) {
        return this.claims.get(hostId) ?? 0;
    }
}

/** The hub's fleet routes: mints tokens, and lets a test say when a host's cell registered. */
export class FakeHubFleet implements HubFleetPort {
    readonly minted: Array<{ hostId: string; token: string }> = [];
    readonly retired: string[] = [];
    refuse?: string;
    /** The next this-many retire calls fail, as a hub that restarts or answers 5xx. */
    failRetires = 0;

    async mint(req: { hostId: string }) {
        if (this.refuse) return { ok: false as const, reason: this.refuse };
        const token = `kcf_test-${req.hostId}-${this.minted.length}`;
        this.minted.push({ hostId: req.hostId, token });
        return { ok: true as const, token };
    }
    async retire(hostId: string) {
        if (this.failRetires > 0) {
            this.failRetires--;
            throw new Error('hub fleet retire answered 503');
        }
        this.retired.push(hostId);
    }
}

export class FixedTemplates implements TemplateResolver {
    constructor(private readonly name: string | null) {}
    async resolve() {
        return this.name;
    }
}

/** A clock that only the durable sleeps move. */
export class FakeClock {
    constructor(public t = Date.parse('2026-11-17T12:00:00Z')) {}
    now = () => this.t;
}

/**
 * DBOS's step semantics for a pure workflow: each named step runs once and its outcome is kept (its output,
 * or the error it ended with); a replay returns the kept output or throws the kept error. A step given a
 * retry runs up to `maxAttempts` times before its error is kept. `crashAfter`: once that many steps
 * completed, the next one never returns, as a process that died mid-workflow (nothing after it runs,
 * nothing is thrown); `crashed` then resolves.
 */
export class RecordingSteps {
    readonly outputs = new Map<string, unknown>();
    /** Steps that ended in an error, and that error (kept as DBOS keeps it). */
    readonly failures = new Map<string, unknown>();
    /** How many times each step's function ran. */
    readonly attempts = new Map<string, number>();
    readonly ran: string[] = [];
    crashAfter?: number;
    /** This step runs (its effect happens) and the process dies before its output is kept. */
    crashInside?: string;
    private done = 0;
    private died!: () => void;
    readonly crashed = new Promise<void>((resolve) => (this.died = resolve));

    constructor(private readonly clock: FakeClock, private readonly onSleep?: (clock: FakeClock) => void | Promise<void>) {}

    step = async <T>(name: string, fn: () => Promise<T>, retry?: StepRetry): Promise<T> => {
        if (this.failures.has(name)) throw this.failures.get(name);
        if (this.outputs.has(name)) return this.outputs.get(name) as T;
        if (this.crashAfter !== undefined && this.done >= this.crashAfter) {
            this.crashAfter = undefined;
            this.died();
            return new Promise<T>(() => undefined);
        }
        let out: T;
        for (let attempt = 1; ; attempt++) {
            this.attempts.set(name, attempt);
            try {
                out = await fn();
                break;
            } catch (e) {
                if (retry && attempt < retry.maxAttempts) {
                    this.clock.t += retry.intervalSeconds * retry.backoffRate ** (attempt - 1) * 1000;
                    continue;
                }
                this.failures.set(name, e);
                this.ran.push(name);
                this.done++;
                throw e;
            }
        }
        if (this.crashInside === name) {
            this.crashInside = undefined;
            this.died();
            return new Promise<T>(() => undefined);
        }
        this.outputs.set(name, out);
        this.ran.push(name);
        this.done++;
        return out;
    };

    sleep = async (ms: number) => {
        this.clock.t += ms;
        await this.onSleep?.(this.clock);
    };
}

export type FleetDepsOverrides = Partial<Omit<PerRunHostDeps, 'step' | 'sleep' | 'now'>>;

/** runtime_env_templates in memory, as PgTemplateStore. */
export class InMemoryTemplateStore implements TemplateStore {
    readonly rows: Array<TemplateRow & { failure?: string; setupHostId?: string; failedAt?: number }> = [];
    private at = 0;
    private readonly readyAt = new Map<TemplateRow, number>();

    private row(o: string, e: string, p: string, f: string) {
        return this.rows.find((t) => t.organizationId === o && t.environmentId === e && t.poolId === p && t.fingerprint === f);
    }
    async find(o: string, e: string, p: string, f: string) {
        const r = this.row(o, e, p, f);
        return r ? { ...r } : null;
    }
    async readyName(o: string, e: string, p: string) {
        const ready = this.rows.filter((t) => t.organizationId === o && t.environmentId === e && t.poolId === p && t.state === 'ready');
        ready.sort((a, b) => (this.readyAt.get(b) ?? 0) - (this.readyAt.get(a) ?? 0));
        return ready[0]?.name ?? null;
    }
    async begin(t: Omit<TemplateRow, 'state'> & { setupHostId?: string }) {
        const r = this.row(t.organizationId, t.environmentId, t.poolId, t.fingerprint);
        if (!r) this.rows.push({ ...t, state: 'building' });
        else if (r.state === 'failed' || r.state === 'replaced') Object.assign(r, { state: 'building', setupHostId: t.setupHostId });
    }
    async buildingSetupHosts() {
        return this.rows.filter((r) => r.state === 'building' && r.setupHostId).map((r) => r.setupHostId!);
    }
    async fail(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>, reason: string) {
        const r = this.row(t.organizationId, t.environmentId, t.poolId, t.fingerprint);
        if (r?.state === 'building') Object.assign(r, { state: 'failed', failure: reason, failedAt: Date.now() });
    }
    async holds(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>, failedAfter: Date) {
        const r = this.row(t.organizationId, t.environmentId, t.poolId, t.fingerprint);
        return !!r && (r.state === 'ready' || r.state === 'building' || (r.state === 'failed' && (r.failedAt ?? 0) > failedAfter.getTime()));
    }
    async promote(t: Pick<TemplateRow, 'organizationId' | 'environmentId' | 'poolId' | 'fingerprint'>) {
        const r = this.row(t.organizationId, t.environmentId, t.poolId, t.fingerprint)!;
        r.state = 'ready';
        this.readyAt.set(r, ++this.at);
        const older = this.rows.filter((x) => x !== r && x.organizationId === t.organizationId && x.environmentId === t.environmentId && x.poolId === t.poolId && x.state === 'ready');
        for (const o of older) o.state = 'replaced';
        return older.map((o) => o.name);
    }
}
