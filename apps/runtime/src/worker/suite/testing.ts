import { type AcquireRequest, type Blocked, type Claim, type EnvError, type ExecRequest, prImageUnavailable, type StepResult } from '@libs/runtime/environment';
import { afterLostClaim, batchSize, MAIN_HISTORY_RUNS, type MainObservation, QUEUE_BATCH_MAX_SPECS, QUEUE_BATCH_TARGET_MS, QUEUE_LEASE_MS, type QueueEntry } from '@libs/runtime/suite';

import type { CoverageMapRecord } from './coverage-collector';
import { POLL_STATES } from './detached-exec';
import type { BaselineRecord, PgSuiteBaselines } from './pg-suite-baselines';
import type { PgSuiteRuns, StoredSuiteResult, SuiteArtifactRef, SuiteRunEnd, StoredSuiteRun, StoredSuiteShard, SuitePhase, SuiteResultRow, SuiteRunRecord, SuiteRunState, SuiteShardPlan } from './pg-suite-runs';
import type { MainRecord, PgSuiteMainResults, StoredMainResult } from './pg-suite-main-results';
import type { LostClaims, PgSuiteQueue, QueueCounts, QueueLeftover } from './pg-suite-queue';
import type { PgSuiteSelectionState, PgSuiteShadows, SelectionState, ShadowRequest, StoredShadow } from './pg-suite-shadows';
import { STATS_WINDOW, type PgSuiteSpecStats, type SpecObservation } from './pg-suite-spec-stats';
import type { SuiteHostDemand, SuiteShardHost } from './suite-engine';

// Test doubles of the suite engine: a clock the poller's sleeps move, and an environment that runs a suite
// command in fake time. Specs only.

export class SuiteClock {
    constructor(public t = Date.parse('2026-11-23T12:00:00Z')) {}
    now = () => this.t;
    sleep = async (ms: number) => {
        this.t += ms;
    };
}

export interface FakeSuiteRun {
    /** How long the command runs before it exits on its own. */
    runMs: number;
    exitCode?: number;
    /** The process dies this long after it started, with no exit status (the runner crashed or the host killed it). */
    diesAtMs?: number;
    /** Result files by the time (after the start) each appears. */
    resultsAt?: Record<string, number>;
    /** The cell has no exec service: every exec that names one is answered exec_service_unavailable. */
    refusesService?: boolean;
    /** Polls (1-based) that answer a lost transport. */
    lostPolls?: number[];
}

/**
 * A cell's exec for a suite command: the start call begins the fake process (once: a second start with the same
 * key finds the marker and does nothing, as the real wrapper does), a poll reads it as of the clock, a kill ends it.
 * Calls are told apart by their step id suffix, which the poller owns.
 */
export class FakeSuiteEnvironment {
    readonly calls: Array<{ kind: 'start' | 'poll' | 'kill'; timeoutMs: number; command: string; service?: string }> = [];
    /** How many times the command itself began running. */
    commandRuns = 0;
    private startedAt: number | undefined;
    private killedAt: number | undefined;
    private polls = 0;

    constructor(
        private readonly clock: { now(): number },
        private readonly run: FakeSuiteRun,
    ) {}

    async exec(_claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
        const kind = req.stepId.endsWith(':start') ? 'start' : req.stepId.endsWith(':kill') ? 'kill' : 'poll';
        this.calls.push({ kind, timeoutMs: req.timeoutMs, command: req.command, ...(req.service !== undefined ? { service: req.service } : {}) });
        if (req.service !== undefined && this.run.refusesService) return { code: 'exec_service_unavailable' };
        if (kind === 'start') {
            if (this.startedAt === undefined) {
                this.startedAt = this.clock.now();
                this.commandRuns++;
            }
            return ok(req.stepId, '');
        }
        if (kind === 'kill') {
            this.killedAt ??= this.clock.now();
            return ok(req.stepId, '');
        }
        this.polls++;
        if (this.run.lostPolls?.includes(this.polls)) return { stepId: req.stepId, exitCode: -1, stdout: '', stderr: '', truncated: false, durationMs: 0, transport: 'lost' };
        const at = this.clock.now() - (this.startedAt ?? this.clock.now());
        const files = Object.entries(this.run.resultsAt ?? {}).filter(([, ms]) => ms <= at).map(([f]) => f);
        const killed = this.killedAt !== undefined;
        const dies = this.run.diesAtMs !== undefined && at >= this.run.diesAtMs;
        const exited = !killed && !dies && at >= this.run.runMs;
        const state = killed || dies ? POLL_STATES.dead : exited ? `${POLL_STATES.exited}${this.run.exitCode ?? 0}` : POLL_STATES.running;
        return ok(req.stepId, [`state=${state}`, ...files.map((f) => `file=${f}`), 'log:', `at ${Math.round(at / 1000)}s`].join('\n'));
    }
}

const ok = (stepId: string, stdout: string): StepResult => ({ stepId, exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, transport: 'ok' });

// ---- in-memory twins of the stores (the same public methods, the same rules the integration specs hold the Postgres ones to)

export class InMemorySuiteRuns implements Pick<PgSuiteRuns, 'create' | 'get' | 'latestForPr' | 'finish' | 'savePlan' | 'markShard' | 'closeShards' | 'shards' | 'recordResults' | 'recordArtifacts' | 'results'> {
    /** Each shard's moments as markShard wrote them, by `<suiteRunId>|<shard>`. */
    readonly moments = new Map<string, { running?: number; finished?: number }>();
    readonly runs = new Map<string, StoredSuiteRun>();
    private readonly plans = new Map<string, Map<number, StoredSuiteShard>>();
    private readonly rows = new Map<string, StoredSuiteResult & { organizationId: string; suiteRunId: string; at: number }>();
    constructor(private readonly clock: { now(): number } = { now: () => 0 }) {}

    async create(r: SuiteRunRecord) {
        if (this.runs.has(r.suiteRunId)) return { created: false };
        this.runs.set(r.suiteRunId, { ...r, state: 'requested' });
        return { created: true };
    }
    async get(organizationId: string, suiteRunId: string) {
        const r = this.runs.get(suiteRunId);
        return r && r.organizationId === organizationId ? r : null;
    }
    async latestForPr(organizationId: string, environmentId: string, prNumber: number, before?: Date) {
        return [...this.runs.values()].filter((r) => r.mode !== 'shadow' && r.organizationId === organizationId && r.environmentId === environmentId && r.prNumber === prNumber && (!before || r.requestedAt.getTime() < before.getTime())).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0] ?? null;
    }
    async finish(organizationId: string, suiteRunId: string, state: SuiteRunState, at: Date, end: SuiteRunEnd = {}) {
        const r = this.runs.get(suiteRunId);
        if (r && r.organizationId === organizationId && !r.finishedAt) Object.assign(r, { state, finishedAt: at, ...(end.classification ? { classification: end.classification } : {}), ...(end.baselineSha ? { baselineSha: end.baselineSha } : {}), ...(end.baseDrift !== undefined ? { baseDrift: end.baseDrift } : {}), ...(end.firstPassMs !== undefined ? { firstPassMs: end.firstPassMs } : {}), ...(end.rerunMs !== undefined ? { rerunMs: end.rerunMs } : {}) });
    }
    async savePlan(organizationId: string, suiteRunId: string, shards: readonly SuiteShardPlan[]) {
        if (this.runs.get(suiteRunId)?.organizationId !== organizationId) return;
        const m = this.plans.get(suiteRunId) ?? new Map<number, StoredSuiteShard>();
        for (const s of shards) m.set(s.shard, { shard: s.shard, specs: [...s.specs], state: m.get(s.shard)?.state ?? 'planned' });
        this.plans.set(suiteRunId, m);
    }
    async markShard(organizationId: string, suiteRunId: string, shard: number, moment: 'running' | 'finished', at: Date) {
        if (this.runs.get(suiteRunId)?.organizationId !== organizationId) return;
        const key = `${suiteRunId}|${shard}`;
        this.moments.set(key, { ...this.moments.get(key), [moment]: at.getTime() });
        const row = this.plans.get(suiteRunId)?.get(shard);
        if (row) row.state = moment;
    }
    async closeShards(organizationId: string, suiteRunId: string, at: Date) {
        if (this.runs.get(suiteRunId)?.organizationId !== organizationId) return;
        for (const [shard, row] of this.plans.get(suiteRunId) ?? []) {
            if (row.state === 'finished') continue;
            row.state = 'finished';
            const key = `${suiteRunId}|${shard}`;
            this.moments.set(key, { ...this.moments.get(key), finished: at.getTime() });
        }
    }
    async shards(organizationId: string, suiteRunId: string) {
        if (this.runs.get(suiteRunId)?.organizationId !== organizationId) return [];
        return [...(this.plans.get(suiteRunId)?.values() ?? [])].sort((a, b) => a.shard - b.shard);
    }
    async recordResults(organizationId: string, suiteRunId: string, from: { phase: SuitePhase; shard: number }, results: readonly SuiteResultRow[]) {
        for (const r of results) this.rows.set(`${suiteRunId}|${from.phase}|${r.spec}`, { ...r, phase: from.phase, shard: from.shard, organizationId, suiteRunId, at: this.clock.now() });
    }
    async recordArtifacts(organizationId: string, suiteRunId: string, from: { phase: SuitePhase; shard: number }, rows: ReadonlyArray<{ spec: string; artifacts: readonly SuiteArtifactRef[] }>) {
        for (const x of rows) {
            const row = this.rows.get(`${suiteRunId}|${from.phase}|${x.spec}`);
            if (row && row.organizationId === organizationId) row.artifacts = [...x.artifacts];
        }
    }
    async results(organizationId: string, suiteRunId: string): Promise<StoredSuiteResult[]> {
        return [...this.rows.values()]
            .filter((r) => r.organizationId === organizationId && r.suiteRunId === suiteRunId)
            .sort((a, b) => (a.phase < b.phase ? -1 : a.phase > b.phase ? 1 : a.spec < b.spec ? -1 : 1))
            .map(({ organizationId: _o, suiteRunId: _s, at: _a, ...r }) => r);
    }
    /** When (the clock) each result row was last written: lets a spec say a result arrived while the shard still ran. */
    recordedAt(suiteRunId: string, phase: SuitePhase, spec: string): number | undefined {
        return this.rows.get(`${suiteRunId}|${phase}|${spec}`)?.at;
    }
}

export class InMemorySuiteSpecStats implements Pick<PgSuiteSpecStats, 'read' | 'record'> {
    readonly rows = new Map<string, { p50Ms: number; samples: number }>();
    async read(scope: { organizationId: string; environmentId: string }, specs: readonly string[]) {
        const out: Record<string, { p50Ms: number }> = {};
        for (const s of specs) {
            const r = this.rows.get(`${scope.organizationId}|${scope.environmentId}|${s}`);
            if (r) out[s] = { p50Ms: r.p50Ms };
        }
        return out;
    }
    async record(scope: { organizationId: string; environmentId: string }, _sha: string, observed: readonly SpecObservation[]) {
        const alpha = 2 / (STATS_WINDOW + 1);
        for (const o of new Map(observed.filter((x) => (x.status === 'passed' || x.status === 'failed') && Number.isFinite(x.durationMs) && x.durationMs >= 0).map((x) => [x.spec, Math.round(x.durationMs)])) ) {
            const key = `${scope.organizationId}|${scope.environmentId}|${o[0]}`;
            const prev = this.rows.get(key);
            this.rows.set(key, prev ? { p50Ms: Math.round(prev.p50Ms + alpha * (o[1] - prev.p50Ms)), samples: prev.samples + 1 } : { p50Ms: o[1], samples: 1 });
        }
    }
}

export class InMemorySuiteBaselines implements Pick<PgSuiteBaselines, 'record' | 'find' | 'findAmong' | 'newest'> {
    readonly rows = new Map<string, BaselineRecord>();
    private key = (e: string, sha: string, digest: string) => `${e}|${sha}|${digest}`;
    async record(b: BaselineRecord) {
        const k = this.key(b.environmentId, b.mainSha, b.suiteDigest);
        const held = this.rows.get(k);
        if (held && !(held.status === 'incomplete' && b.status === 'complete' && held.organizationId === b.organizationId)) return { stored: false };
        this.rows.set(k, b);
        return { stored: true };
    }
    async newest(organizationId: string, environmentId: string) {
        const b = [...this.rows.values()].filter((r) => r.organizationId === organizationId && r.environmentId === environmentId && r.status === 'complete').sort((a, c) => c.finishedAt.getTime() - a.finishedAt.getTime())[0];
        return b ? { mainSha: b.mainSha, suiteDigest: b.suiteDigest, finishedAt: b.finishedAt } : null;
    }
    async find(organizationId: string, environmentId: string, mainSha: string, suiteDigest: string) {
        return this.findAmong(organizationId, environmentId, suiteDigest, [mainSha]);
    }
    async findAmong(organizationId: string, environmentId: string, suiteDigest: string, shas: readonly string[]) {
        for (const sha of shas) {
            const b = this.rows.get(this.key(environmentId, sha, suiteDigest));
            if (b && b.organizationId === organizationId && b.status === 'complete') return b;
        }
        return null;
    }
}

/** What main said of each spec, as the Postgres store keeps it (append-only, idempotent per run and spec). */
export class InMemorySuiteMainResults implements Pick<PgSuiteMainResults, 'record' | 'at' | 'history'> {
    readonly records: MainRecord[] = [];
    private rows: Array<MainObservation & { organizationId: string; environmentId: string; suiteRunId: string; suiteDigest: string; spec: string; tests: MainRecord['rows'][number]['tests'] }> = [];
    async record(r: MainRecord) {
        this.records.push(r);
        for (const x of r.rows) {
            if (this.rows.some((o) => o.suiteRunId === r.suiteRunId && o.spec === x.spec)) continue;
            this.rows.push({ organizationId: r.organizationId, environmentId: r.environmentId, suiteRunId: r.suiteRunId, suiteDigest: r.suiteDigest, spec: x.spec, mainSha: r.mainSha, status: x.status, ...(x.errorSignature ? { errorSignature: x.errorSignature } : {}), observedAt: r.observedAt.getTime(), tests: x.tests });
        }
    }
    async at(organizationId: string, environmentId: string, suiteDigest: string, shas: readonly string[], specs: readonly string[]) {
        const out = new Map<string, StoredMainResult>();
        for (const spec of specs) {
            for (const sha of shas) {
                const hit = this.rows.filter((o) => o.organizationId === organizationId && o.environmentId === environmentId && o.suiteDigest === suiteDigest && o.spec === spec && o.mainSha === sha);
                if (hit.length === 0) continue;
                out.set(spec, { mainSha: sha, observations: hit.map(({ organizationId: _o, environmentId: _e, suiteRunId: _r, suiteDigest: _d, spec: _s, ...o }) => o) });
                break;
            }
        }
        return out;
    }
    async history(organizationId: string, environmentId: string, specs: readonly string[]) {
        const out = new Map<string, MainObservation[]>();
        for (const spec of specs) {
            const list = this.rows.filter((o) => o.organizationId === organizationId && o.environmentId === environmentId && o.spec === spec).sort((a, b) => b.observedAt - a.observedAt).slice(0, MAIN_HISTORY_RUNS).map((o) => ({ mainSha: o.mainSha, status: o.status, ...(o.errorSignature ? { errorSignature: o.errorSignature } : {}), observedAt: o.observedAt }));
            if (list.length > 0) out.set(spec, list);
        }
        return out;
    }
}

/** The coverage maps of baselines: one per (environment, main sha, suite digest); a complete one replaces an incomplete one and nothing else. */
export class InMemorySuiteCoverageMaps {
    readonly rows = new Map<string, CoverageMapRecord>();
    private key = (e: string, sha: string, digest: string) => `${e}|${sha}|${digest}`;
    async record(m: CoverageMapRecord) {
        const k = this.key(m.environmentId, m.mainSha, m.suiteDigest);
        const held = this.rows.get(k);
        if (held && !(held.status === 'incomplete' && m.status === 'complete' && held.organizationId === m.organizationId)) return { stored: false };
        this.rows.set(k, m);
        return { stored: true };
    }
    /** The newest complete map of the environment, as the Postgres store answers it. */
    async newest(organizationId: string, environmentId: string) {
        const m = [...this.rows.values()].filter((r) => r.organizationId === organizationId && r.environmentId === environmentId && r.status === 'complete').sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())[0];
        return m ? { mainSha: m.mainSha, suiteDigest: m.suiteDigest, finishedAt: m.finishedAt, specs: m.specs } : undefined;
    }
}

/** The shadows of selected runs, as the Postgres store keeps them. */
export class InMemorySuiteShadows implements Pick<PgSuiteShadows, 'request' | 'get' | 'pending' | 'markStarted' | 'complete' | 'recentMisses'> {
    readonly rows = new Map<string, StoredShadow & { finishedAt?: Date }>();
    async request(r: ShadowRequest) {
        if ([...this.rows.values()].some((x) => x.sourceRunId === r.sourceRunId) || this.rows.has(r.shadowRunId)) return { created: false };
        this.rows.set(r.shadowRunId, { ...r, state: 'queued', misses: [] });
        return { created: true };
    }
    async get(organizationId: string, shadowRunId: string) {
        const r = this.rows.get(shadowRunId);
        return r && r.organizationId === organizationId ? r : null;
    }
    async pending(limit: number) {
        return [...this.rows.values()].filter((r) => r.state === 'queued').slice(0, limit);
    }
    async markStarted(organizationId: string, shadowRunId: string) {
        const r = this.rows.get(shadowRunId);
        if (r && r.organizationId === organizationId && r.state === 'queued') r.state = 'started';
    }
    async complete(organizationId: string, shadowRunId: string, result: { misses: readonly string[]; conclusive: boolean }, at: Date = new Date(0)) {
        const r = this.rows.get(shadowRunId);
        if (!r || r.organizationId !== organizationId || r.state === 'done') return { first: false };
        Object.assign(r, { state: 'done', misses: [...result.misses], conclusive: result.conclusive, finishedAt: at });
        return { first: true };
    }
    async recentMisses(organizationId: string, environmentId: string, window = 10, since?: Date) {
        const done = [...this.rows.values()].filter((r) => r.organizationId === organizationId && r.environmentId === environmentId && r.state === 'done' && r.conclusive && (!since || r.finishedAt! > since));
        return done.sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime()).slice(0, window).reduce((n, r) => n + r.misses.length, 0);
    }
}

/** What each environment's selection is doing because of the shadow check. */
export class InMemorySuiteSelectionState implements Pick<PgSuiteSelectionState, 'read' | 'recordSelected' | 'applyMiss' | 'consumeFullPr' | 'reenable' | 'turnOff'> {
    readonly rows = new Map<string, { organizationId: string; selected: number; fullPrsLeft: number; off: boolean; offBy?: 'brake' | 'person'; reenabledAt?: Date }>();
    private row(o: string, e: string) {
        const r = this.rows.get(e) ?? { organizationId: o, selected: 0, fullPrsLeft: 0, off: false };
        this.rows.set(e, r);
        return r.organizationId === o ? r : undefined;
    }
    async read(o: string, e: string): Promise<SelectionState> {
        const r = this.rows.get(e);
        return r && r.organizationId === o ? { off: r.off, ...(r.off && r.offBy ? { offBy: r.offBy } : {}), fullPrsLeft: r.fullPrsLeft, ...(r.reenabledAt ? { reenabledAt: r.reenabledAt } : {}) } : { off: false, fullPrsLeft: 0 };
    }
    async recordSelected(o: string, e: string) {
        const r = this.row(o, e);
        return r ? ++r.selected : 0;
    }
    async applyMiss(o: string, e: string, brake: { fullPrs: number; off: boolean }) {
        const r = this.row(o, e);
        if (r) Object.assign(r, { fullPrsLeft: brake.fullPrs, off: r.off || brake.off, ...(brake.off && !r.off ? { offBy: 'brake' as const } : {}) });
    }
    async consumeFullPr(o: string, e: string) {
        const r = this.rows.get(e);
        if (r && r.organizationId === o) r.fullPrsLeft = Math.max(0, r.fullPrsLeft - 1);
    }
    async turnOff(o: string, e: string) {
        const r = this.row(o, e);
        if (r && !r.off) Object.assign(r, { off: true, offBy: 'person' as const });
    }
    async reenable(o: string, e: string, at: Date = new Date(0)) {
        const r = this.rows.get(e);
        if (!r || r.organizationId !== o) return undefined;
        Object.assign(r, { off: false, offBy: undefined, fullPrsLeft: 0, reenabledAt: at });
        return at;
    }
}

/** The spec queue of a suite run, as the Postgres store keeps it (same methods, same rules: the integration spec holds the Postgres one to them). */
export class InMemorySuiteQueue implements Pick<PgSuiteQueue, 'seed' | 'claimNext' | 'renew' | 'complete' | 'release' | 'requeueExpired' | 'counts' | 'leftovers'> {
    private readonly rows = new Map<string, QueueEntry & { organizationId: string; suiteRunId: string; state: 'queued' | 'claimed' | 'done' | 'abandoned'; claimedBy?: number; attempts: number; leaseExpiresAt?: number }>();
    /** Every pull, in order, for a spec to read what the shards were handed. */
    readonly pulls: Array<{ shard: number; specs: string[] }> = [];
    private key = (run: string, spec: string) => `${run}|${spec}`;
    private of(o: string, run: string) {
        return [...this.rows.values()].filter((r) => r.organizationId === o && r.suiteRunId === run);
    }
    async seed(organizationId: string, suiteRunId: string, entries: readonly QueueEntry[]) {
        let n = 0;
        for (const e of entries) {
            if (this.rows.has(this.key(suiteRunId, e.spec))) continue;
            this.rows.set(this.key(suiteRunId, e.spec), { ...e, organizationId, suiteRunId, state: 'queued', attempts: 0 });
            n++;
        }
        return n;
    }
    async claimNext(c: { organizationId: string; suiteRunId: string; shard: number; now: Date; leaseMs?: number; targetMs?: number; maxSpecs?: number }) {
        const queued = this.of(c.organizationId, c.suiteRunId).filter((r) => r.state === 'queued').sort((a, b) => a.priority - b.priority || b.weight - a.weight || (a.spec < b.spec ? -1 : 1));
        const take = queued.slice(0, batchSize(queued, { targetMs: c.targetMs ?? QUEUE_BATCH_TARGET_MS, maxSpecs: c.maxSpecs ?? QUEUE_BATCH_MAX_SPECS }));
        for (const r of take) Object.assign(r, { state: 'claimed', claimedBy: c.shard, attempts: r.attempts + 1, leaseExpiresAt: c.now.getTime() + (c.leaseMs ?? QUEUE_LEASE_MS) });
        if (take.length > 0) this.pulls.push({ shard: c.shard, specs: take.map((r) => r.spec) });
        return take.map((r) => r.spec);
    }
    async renew(organizationId: string, suiteRunId: string, shard: number, now: Date, leaseMs: number = QUEUE_LEASE_MS) {
        for (const r of this.of(organizationId, suiteRunId)) if (r.state === 'claimed' && r.claimedBy === shard) r.leaseExpiresAt = now.getTime() + leaseMs;
    }
    async complete(organizationId: string, suiteRunId: string, specs: readonly string[], _now: Date) {
        for (const r of this.of(organizationId, suiteRunId)) if (specs.includes(r.spec) && (r.state === 'claimed' || r.state === 'queued')) Object.assign(r, { state: 'done', leaseExpiresAt: undefined });
    }
    private lose(rows: Array<{ state: string; attempts: number; spec: string; claimedBy?: number; leaseExpiresAt?: number }>): LostClaims {
        const out: LostClaims = { requeued: [], abandoned: [] };
        for (const r of rows) {
            const next = afterLostClaim(r.attempts);
            Object.assign(r, { state: next, leaseExpiresAt: undefined, ...(next === 'queued' ? { claimedBy: undefined } : {}) });
            (next === 'queued' ? out.requeued : out.abandoned).push(r.spec);
        }
        return out;
    }
    async release(organizationId: string, suiteRunId: string, shard: number, _now: Date, specs?: readonly string[]) {
        return this.lose(this.of(organizationId, suiteRunId).filter((r) => r.state === 'claimed' && r.claimedBy === shard && (!specs || specs.includes(r.spec))));
    }
    async requeueExpired(organizationId: string, suiteRunId: string, now: Date) {
        return this.lose(this.of(organizationId, suiteRunId).filter((r) => r.state === 'claimed' && r.leaseExpiresAt !== undefined && r.leaseExpiresAt <= now.getTime()));
    }
    async counts(organizationId: string, suiteRunId: string): Promise<QueueCounts> {
        const out: QueueCounts = { queued: 0, claimed: 0, done: 0, abandoned: 0 };
        for (const r of this.of(organizationId, suiteRunId)) out[r.state]++;
        return out;
    }
    async leftovers(organizationId: string, suiteRunId: string): Promise<QueueLeftover[]> {
        return this.of(organizationId, suiteRunId)
            .filter((r) => r.state !== 'done')
            .sort((a, b) => a.priority - b.priority || b.weight - a.weight || (a.spec < b.spec ? -1 : 1))
            .map((r) => ({ spec: r.spec, state: r.state as QueueLeftover['state'], ...(r.claimedBy !== undefined ? { claimedBy: r.claimedBy } : {}) }));
    }
}

/** The fleet's demand rows for a suite run, as the engine sees them: which shards asked for a host, which hosts came. */
export class FakeSuiteDemand implements SuiteHostDemand {
    readonly requested: number[][] = [];
    readonly requestedAt: number[] = [];
    ended = 0;
    constructor(private readonly clock: { now(): number } = { now: () => 0 }) {}
    /** Shards whose host the fleet failed to make. */
    readonly failed = new Set<number>();
    /** Shards whose host never comes up (stays starting). */
    readonly stuck = new Set<number>();
    /** When set, every host stays starting until the clock reaches it (a host that takes long to register). */
    readyAt?: number;
    private asked = new Set<number>();
    async request(d: { shards: readonly number[] }) {
        this.requested.push([...d.shards]);
        this.requestedAt.push(this.clock.now());
        for (const s of d.shards) this.asked.add(s);
    }
    async status(): Promise<SuiteShardHost[]> {
        const late = this.readyAt !== undefined && this.clock.now() < this.readyAt;
        return [...this.asked].sort((a, b) => a - b).map((shard): SuiteShardHost => (this.failed.has(shard) ? { shard, state: 'failed', failure: 'host_unavailable' } : { shard, state: this.stuck.has(shard) || late ? 'starting' : 'ready' }));
    }
    async end() {
        this.ended++;
    }
}

// ---- a fake cell that runs a suite command in fake time

/** What one attempt of a spec does: passes, fails with an error line, or kills the runner process before it reports. */
export type FakeAttempt = 'pass' | { fail: string } | 'crash';
export interface FakeSpec {
    /** How long the spec takes (default 20 s). */
    ms?: number;
    /** The source files the spec exercises on main, as the coverage collector would read them from the V8 dumps of its run (baseline only). */
    covers?: string[];
    /** The collector finds no dump for this spec (the runner left none). */
    noCoverage?: boolean;
    /** What each attempt on that side does, in order; the last one repeats. Default: passes. */
    pr?: FakeAttempt[];
    main?: FakeAttempt[];
}
export interface FakeSuiteWorld {
    specs: Record<string, FakeSpec>;
    /** An acquire this answers true for is blocked (no host, no capacity). */
    blocked?: (req: AcquireRequest) => boolean;
    /** An acquire this answers a cause for is refused as `PR image unavailable: <cause>` (the hub's answer for a Run's shard with no PR image). */
    prImageUnavailable?: (req: AcquireRequest) => string | undefined;
    /** The cell has no exec service: every exec that names one is answered exec_service_unavailable. */
    refusesService?: boolean;
    /** What the runner prints last on every poll (its log tail), after the fake's own clock line. */
    log?: string;
    /** What the runner spends before each spec beyond the spec's own duration (the browser start): the report's duration does not count it. */
    overheadMs?: number;
    /** An acquire this answers a number for takes that long to be ready (a slow boot of the PR build on its host). */
    acquireDelayMs?: (req: AcquireRequest) => number | undefined;
}

interface FakeProcess {
    startedAt: number;
    exitAt: number;
    exitCode: number;
    diesAt?: number;
    killedAt?: number;
    files: Array<{ path: string; doneAt: number }>;
}

const XML_ESC = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fileOf = (spec: string) => `results/${spec.replace(/[^A-Za-z0-9.]/g, '_')}.xml`;

/**
 * Acquire, exec and release of a suite engine's environment, in fake time: a claim records its side and shard; the start
 * script of a detached command is read for its `--specs "a,b"` list; each spec runs one after the other and its JUnit
 * file appears when it ends, with the outcome the world gives that side and attempt; a poll answers as of the clock; a
 * `cat` of a result file answers its XML. The runner's JUnit is real text, so the engine's parsing is exercised as is.
 */
export class FakeSuiteCell {
    readonly claims = new Map<string, { claimId: string; side: string; sha: string; shard?: number; released: boolean; key: string }>();
    readonly acquires: AcquireRequest[] = [];
    /** Starts of the command, by claim (a replay of a start does nothing). */
    readonly starts: Array<{ claimId: string; specs: string[]; env: Record<string, string> }> = [];
    /** The most commands that ran at once on one claim: a service never sees two specs together in a baseline. */
    maxConcurrentOnClaim = 0;
    /** The coverage collector's reads: the directory it was asked about. */
    readonly coverageReads: string[] = [];
    /** The service each exec named, in order (undefined: the public service). */
    readonly execServices: Array<{ stepId: string; service?: string }> = [];
    private readonly coverageDirs = new Map<string, string>();
    readonly released: string[] = [];
    private readonly procs = new Map<string, FakeProcess>();
    private readonly xml = new Map<string, string>();
    private readonly attempts = new Map<string, number>();
    private readonly lost = new Set<string>();

    constructor(
        private readonly clock: { now(): number; sleep?(ms: number): Promise<void> },
        private readonly world: FakeSuiteWorld,
    ) {}

    /** Every poll of this claim answers a lost transport (the host went away). */
    loseHostOf(claimId: string) {
        this.lost.add(claimId);
    }

    async acquire(req: AcquireRequest): Promise<Claim | Blocked> {
        this.acquires.push(req);
        if (this.world.blocked?.(req)) return { status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'no host' }] };
        const noImage = this.world.prImageUnavailable?.(req);
        if (noImage !== undefined) return prImageUnavailable(noImage);
        const delay = this.world.acquireDelayMs?.(req);
        if (delay && this.clock.sleep) {
            // Ready when the shared fake clock reaches it, whoever advances it.
            const readyAt = this.clock.now() + delay;
            while (this.clock.now() < readyAt) await this.clock.sleep(1_000);
        }
        const claimId = `claim:${req.idempotencyKey}`;
        this.claims.set(claimId, { claimId, side: req.ref.side, sha: req.ref.sha, ...(req.shard !== undefined ? { shard: req.shard } : {}), released: false, key: req.idempotencyKey });
        return { claimId, cellId: 'cell-fake', cellOwner: 'kodus', leaseExpiresAt: '2099-01-01T00:00:00Z', hardExpiresAt: '2099-01-01T00:00:00Z', observer: { id: 'o', state: 'ready' }, manifest: { services: [], expose: [], imageId: 'img', seedSha: 's' } } as Claim;
    }

    async release(claimId: string) {
        const c = this.claims.get(claimId);
        if (c) c.released = true;
        this.released.push(claimId);
    }

    async exec(claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
        const claim = this.claims.get(claimId);
        if (!claim || claim.released) return { code: 'lease_expired' };
        this.execServices.push({ stepId: req.stepId, ...(req.service !== undefined ? { service: req.service } : {}) });
        if (req.service !== undefined && this.world.refusesService) return { code: 'exec_service_unavailable' };
        const ok = (stdout: string): StepResult => ({ stepId: req.stepId, exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, transport: 'ok' });
        if (req.stepId.endsWith(':start')) return ok(this.start(claim, req));
        const key = req.stepId.split(':')[0];
        const proc = this.procs.get(`${claimId}|${key}`);
        if (req.stepId.endsWith(':kill')) {
            if (proc) proc.killedAt ??= this.clock.now();
            return ok('');
        }
        if (req.stepId.endsWith(':cov')) {
            const dir = /'(\/[^']+)'/.exec(req.command)?.[1] ?? '';
            this.coverageReads.push(dir);
            const spec = this.coverageDirs.get(dir);
            const plan = spec ? this.world.specs[spec] : undefined;
            if (!plan || plan.noCoverage) return { stepId: req.stepId, exitCode: 1, stdout: '', stderr: 'no coverage dump', truncated: false, durationMs: 1, transport: 'ok' };
            return ok(JSON.stringify({ files: [...(plan.covers ?? [])].sort() }));
        }
        if (req.stepId.endsWith(':clear')) {
            for (const [id, p] of this.procs) if (id.startsWith(`${claimId}|`)) p.files = [];
            return ok('');
        }
        if (req.stepId.includes(':read:')) {
            const path = /cat -- '([^']+)'/.exec(req.command)?.[1] ?? '';
            const body = this.xml.get(`${claimId}|${path}`);
            return body === undefined ? { stepId: req.stepId, exitCode: 1, stdout: '', stderr: 'no such file', truncated: false, durationMs: 1, transport: 'ok' } : ok(body);
        }
        if (this.lost.has(claimId)) return { stepId: req.stepId, exitCode: -1, stdout: '', stderr: '', truncated: false, durationMs: 0, transport: 'lost' };
        if (!proc) return ok(['state=dead', 'log:'].join('\n'));
        const at = this.clock.now() - proc.startedAt;
        const stopAt = proc.killedAt !== undefined ? proc.killedAt - proc.startedAt : proc.diesAt;
        // The glob lists every file in the directory, whichever process of the claim wrote it.
        const mine = [...this.procs].filter(([id]) => id.startsWith(`${claimId}|`)).map(([, p]) => p);
        const now = this.clock.now();
        const files = mine.flatMap((p) => p.files.filter((f) => p.startedAt + f.doneAt <= now && (p.killedAt === undefined || p.startedAt + f.doneAt <= p.killedAt) && (p.diesAt === undefined || f.doneAt <= p.diesAt))).map((f) => `file=${f.path}`);
        const state = stopAt !== undefined && at >= stopAt ? POLL_STATES.dead : at >= proc.exitAt ? `${POLL_STATES.exited}${proc.exitCode}` : POLL_STATES.running;
        return ok([`state=${state}`, ...files, 'log:', `at ${Math.round(at / 1000)}s`, ...(this.world.log ? [this.world.log] : [])].join('\n'));
    }

    private start(claim: { claimId: string; side: string }, req: ExecRequest): string {
        const key = req.stepId.split(':')[0];
        const id = `${claim.claimId}|${key}`;
        if (this.procs.has(id)) return '';
        const specs = (/--specs "([^"]*)"/.exec(req.command)?.[1] ?? '').split(',').filter(Boolean);
        const env = Object.fromEntries([...req.command.matchAll(/^export ([A-Z_][A-Z0-9_]*)='([^']*)'$/gm)].map((m) => [m[1], m[2]]));
        this.starts.push({ claimId: claim.claimId, specs, env });
        if (env.NODE_V8_COVERAGE && specs[0]) this.coverageDirs.set(env.NODE_V8_COVERAGE, specs[0]);
        const side = claim.side === 'pr' ? 'pr' : 'main';
        const now = this.clock.now();
        const proc: FakeProcess = { startedAt: now, exitAt: 0, exitCode: 0, files: [] };
        let t = 0;
        for (const spec of specs) {
            const plan = this.world.specs[spec] ?? {};
            const sequence = plan[side] ?? ['pass'];
            const outcome = sequence[Math.min(this.attempts.get(`${side}|${spec}`) ?? 0, sequence.length - 1)];
            this.attempts.set(`${side}|${spec}`, (this.attempts.get(`${side}|${spec}`) ?? 0) + 1);
            if (outcome === 'crash') {
                proc.diesAt = t;
                break;
            }
            t += (this.world.overheadMs ?? 0) + (plan.ms ?? 20_000);
            const failed = typeof outcome === 'object';
            if (failed) proc.exitCode = 1;
            const path = fileOf(spec);
            const seconds = ((plan.ms ?? 20_000) / 1000).toFixed(3);
            this.xml.set(
                `${claim.claimId}|${path}`,
                `<testsuites><testsuite name="${XML_ESC(spec)}" file="${XML_ESC(spec)}" tests="1" time="${seconds}"><testcase name="${XML_ESC(spec)} works" classname="works" time="${seconds}">${failed ? `<failure message="${XML_ESC(outcome.fail)}">${XML_ESC(outcome.fail)}</failure>` : ''}</testcase></testsuite></testsuites>`,
            );
            proc.files.push({ path, doneAt: t });
        }
        proc.exitAt = t;
        const live = [...this.procs].filter(([pid, p]) => pid.startsWith(`${claim.claimId}|`) && p.killedAt === undefined && now < p.startedAt + p.exitAt).length;
        this.maxConcurrentOnClaim = Math.max(this.maxConcurrentOnClaim, live + 1);
        this.procs.set(id, proc);
        return '';
    }
}
