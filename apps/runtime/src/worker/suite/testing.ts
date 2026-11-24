import type { AcquireRequest, Blocked, Claim, EnvError, ExecRequest, StepResult } from '@libs/runtime/environment';

import { POLL_STATES } from './detached-exec';
import type { BaselineRecord, PgSuiteBaselines } from './pg-suite-baselines';
import type { PgSuiteRuns, StoredSuiteResult, StoredSuiteRun, StoredSuiteShard, SuitePhase, SuiteResultRow, SuiteRunRecord, SuiteRunState, SuiteShardPlan } from './pg-suite-runs';
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
    /** Polls (1-based) that answer a lost transport. */
    lostPolls?: number[];
}

/**
 * A cell's exec for a suite command: the start call begins the fake process (once: a second start with the same
 * key finds the marker and does nothing, as the real wrapper does), a poll reads it as of the clock, a kill ends it.
 * Calls are told apart by their step id suffix, which the poller owns.
 */
export class FakeSuiteEnvironment {
    readonly calls: Array<{ kind: 'start' | 'poll' | 'kill'; timeoutMs: number; command: string }> = [];
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
        this.calls.push({ kind, timeoutMs: req.timeoutMs, command: req.command });
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

export class InMemorySuiteRuns implements Pick<PgSuiteRuns, 'create' | 'get' | 'latestForPr' | 'finish' | 'savePlan' | 'shards' | 'recordResults' | 'results'> {
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
    async latestForPr(organizationId: string, environmentId: string, prNumber: number) {
        return [...this.runs.values()].filter((r) => r.organizationId === organizationId && r.environmentId === environmentId && r.prNumber === prNumber).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())[0] ?? null;
    }
    async finish(organizationId: string, suiteRunId: string, state: SuiteRunState, at: Date) {
        const r = this.runs.get(suiteRunId);
        if (r && r.organizationId === organizationId && !r.finishedAt) Object.assign(r, { state, finishedAt: at });
    }
    async savePlan(organizationId: string, suiteRunId: string, shards: readonly SuiteShardPlan[]) {
        if (this.runs.get(suiteRunId)?.organizationId !== organizationId) return;
        const m = this.plans.get(suiteRunId) ?? new Map<number, StoredSuiteShard>();
        for (const s of shards) m.set(s.shard, { shard: s.shard, specs: [...s.specs], state: m.get(s.shard)?.state ?? 'planned' });
        this.plans.set(suiteRunId, m);
    }
    async shards(organizationId: string, suiteRunId: string) {
        if (this.runs.get(suiteRunId)?.organizationId !== organizationId) return [];
        return [...(this.plans.get(suiteRunId)?.values() ?? [])].sort((a, b) => a.shard - b.shard);
    }
    async recordResults(organizationId: string, suiteRunId: string, from: { phase: SuitePhase; shard: number }, results: readonly SuiteResultRow[]) {
        for (const r of results) this.rows.set(`${suiteRunId}|${from.phase}|${r.spec}`, { ...r, phase: from.phase, shard: from.shard, organizationId, suiteRunId, at: this.clock.now() });
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
        for (const o of new Map(observed.filter((x) => x.status === 'passed' && Number.isFinite(x.durationMs) && x.durationMs >= 0).map((x) => [x.spec, Math.round(x.durationMs)])) ) {
            const key = `${scope.organizationId}|${scope.environmentId}|${o[0]}`;
            const prev = this.rows.get(key);
            this.rows.set(key, prev ? { p50Ms: Math.round(prev.p50Ms + alpha * (o[1] - prev.p50Ms)), samples: prev.samples + 1 } : { p50Ms: o[1], samples: 1 });
        }
    }
}

export class InMemorySuiteBaselines implements Pick<PgSuiteBaselines, 'record' | 'find' | 'findAmong'> {
    readonly rows = new Map<string, BaselineRecord>();
    private key = (e: string, sha: string, digest: string) => `${e}|${sha}|${digest}`;
    async record(b: BaselineRecord) {
        const k = this.key(b.environmentId, b.mainSha, b.suiteDigest);
        const held = this.rows.get(k);
        if (held && !(held.status === 'incomplete' && b.status === 'complete' && held.organizationId === b.organizationId)) return { stored: false };
        this.rows.set(k, b);
        return { stored: true };
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
    private asked = new Set<number>();
    async request(d: { shards: readonly number[] }) {
        this.requested.push([...d.shards]);
        this.requestedAt.push(this.clock.now());
        for (const s of d.shards) this.asked.add(s);
    }
    async status(): Promise<SuiteShardHost[]> {
        return [...this.asked].sort((a, b) => a - b).map((shard): SuiteShardHost => (this.failed.has(shard) ? { shard, state: 'failed', failure: 'host_unavailable' } : { shard, state: this.stuck.has(shard) ? 'starting' : 'ready' }));
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
    /** What each attempt on that side does, in order; the last one repeats. Default: passes. */
    pr?: FakeAttempt[];
    main?: FakeAttempt[];
}
export interface FakeSuiteWorld {
    specs: Record<string, FakeSpec>;
    /** An acquire this answers true for is blocked (no host, no capacity). */
    blocked?: (req: AcquireRequest) => boolean;
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
    readonly starts: Array<{ claimId: string; specs: string[] }> = [];
    readonly released: string[] = [];
    private readonly procs = new Map<string, FakeProcess>();
    private readonly xml = new Map<string, string>();
    private readonly attempts = new Map<string, number>();
    private readonly lost = new Set<string>();

    constructor(
        private readonly clock: { now(): number },
        private readonly world: FakeSuiteWorld,
    ) {}

    /** Every poll of this claim answers a lost transport (the host went away). */
    loseHostOf(claimId: string) {
        this.lost.add(claimId);
    }

    async acquire(req: AcquireRequest): Promise<Claim | Blocked> {
        this.acquires.push(req);
        if (this.world.blocked?.(req)) return { status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'no host' }] };
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
        const ok = (stdout: string): StepResult => ({ stepId: req.stepId, exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, transport: 'ok' });
        if (req.stepId.endsWith(':start')) return ok(this.start(claim, req));
        const key = req.stepId.split(':')[0];
        const proc = this.procs.get(`${claimId}|${key}`);
        if (req.stepId.endsWith(':kill')) {
            if (proc) proc.killedAt ??= this.clock.now();
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
        return ok([`state=${state}`, ...files, 'log:', `at ${Math.round(at / 1000)}s`].join('\n'));
    }

    private start(claim: { claimId: string; side: string }, req: ExecRequest): string {
        const key = req.stepId.split(':')[0];
        const id = `${claim.claimId}|${key}`;
        if (this.procs.has(id)) return '';
        const specs = (/--specs "([^"]*)"/.exec(req.command)?.[1] ?? '').split(',').filter(Boolean);
        this.starts.push({ claimId: claim.claimId, specs });
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
            t += plan.ms ?? 20_000;
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
        this.procs.set(id, proc);
        return '';
    }
}
