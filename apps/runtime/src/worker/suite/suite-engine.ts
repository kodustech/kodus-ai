import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { type EnvironmentRuntime, isBlocked } from '@libs/runtime/environment';
import type { EnvError, StepResult } from '@libs/runtime/environment';
import {
    balanceSpecs,
    type BaselineEvidence,
    type Classification,
    BASELINE_MAX_COMMITS_BEHIND,
    classifyFailures,
    errorSignature,
    estimateDurations,
    estimateTotalMs,
    hostsToAsk,
    needsMainRerun,
    orderBin,
    parseJUnit,
    parseMochawesome,
    planReruns,
    type Rerun,
    shardCount,
    spreadOnto,
    suiteDigestOf,
    type SpecResult,
    type SpecStats,
    type SuiteFailure,
    type SuiteSpecFile,
    testKey,
    type TestResult,
} from '@libs/runtime/suite';

import { type DetachedOutcome, runDetached } from './detached-exec';
import type { BaselineSpec, PgSuiteBaselines } from './pg-suite-baselines';
import type { PgSuiteRuns, SuitePhase, SuiteRunState, SuiteSpecStatus } from './pg-suite-runs';
import type { PgSuiteSpecStats } from './pg-suite-spec-stats';
import type { SuiteShardHost } from '../../shared/persistence/suite-demand';

export type { SuiteShardHost };

// The suite engine's first pass (docs/runtime/e2e-suites.md sections 2.2, 6, 9.2, 11 and 14): plan the shards from the
// stored durations, ask the fleet for one host per shard, run each shard's specs detached in its own claim, read the
// runner's result files as they appear and store each spec's result at once. A plain module with ports (the stores,
// the demand, the environment, a clock): no DBOS and no I/O of its own; a workflow wraps it later, as `runRuntimeRun`
// wraps a Run.

/** What the engine reads of the recipe's `suite` block (the loader resolves defaults and checks the limits). */
export interface SuiteConfig {
    runner: 'cypress' | 'playwright';
    /** The runner command; `{specs}` is filled with the shard's spec files. */
    command: string;
    cwd?: string;
    env: Record<string, string>;
    /** Where the runner writes its result files (JUnit XML, or Mochawesome JSON), relative to `cwd`. */
    resultsGlob: string;
    /** The cap of one shard's command (the recipe's `timeout.shard`). */
    shardTimeoutMs: number;
    /** `suite.shards`: a ceiling. */
    maxShards: number;
    /** `suite.gate`: `strict` fails the run on any unclassified failure; default leaves it neutral (D4). */
    gate?: 'default' | 'strict';
}

export interface SuiteInputs {
    config: SuiteConfig;
    /** The spec files this run executes, relative to `config.cwd` (the whole suite, or the selection). */
    specs: readonly SuiteSpecFile[];
    /** Main commits the template is ahead of the PR's merge base (8.2); absent: counted from `mainHistory`, else 0. */
    baseDrift?: number;
    /** Specs the PR's diff reaches (the coverage map, entry points): a pass on a main that is ahead only confirms a regression for these. */
    diffReachedSpecs?: readonly string[];
    /**
     * The main branch's commits, its head first (`mainSha`), newest to oldest, at least as far back as the PR's merge base
     * and the baseline window: how far main is ahead of the merge base (8.2) and how old a baseline is are counted in it.
     */
    mainHistory?: readonly string[];
    /** The digest of the whole suite (the block and the full spec list); absent: of `config` and `specs`. A selection passes the whole suite's. */
    suiteDigest?: string;
}

/** Whether the environment has a ready template to start a main host from, and a way to ask for a build (9.5). */
export interface SuiteTemplates {
    hasReady(organizationId: string, environmentId: string): Promise<boolean>;
    requestBuild?(organizationId: string, environmentId: string): Promise<void>;
}

/** The fleet's demand for a suite run's hosts (`PgSuiteDemand` bound to the pool the environment runs on). */
export interface SuiteHostDemand {
    request(d: { organizationId: string; environmentId: string; suiteRunId: string; shards: readonly number[] }): Promise<void>;
    status(): Promise<SuiteShardHost[]>;
    end(): Promise<void>;
}

export interface SuiteEngineDeps {
    env: Pick<EnvironmentRuntime, 'acquire' | 'exec' | 'release'>;
    runs: Pick<PgSuiteRuns, 'create' | 'get' | 'finish' | 'savePlan' | 'recordResults'>;
    stats: Pick<PgSuiteSpecStats, 'read' | 'record'>;
    demand: SuiteHostDemand;
    clock: { now(): number; sleep(ms: number): Promise<void> };
    /** How many hosts the pool can start now; absent: no limit but the suite's own ceiling. */
    headroom?(): Promise<number>;
    /** Absent: a template is taken to be ready. */
    templates?: SuiteTemplates;
    /** The baselines of main commits: a baseline run records one, a PR run reads the one of its merge base. Absent: none is kept or used. */
    baselines?: Pick<PgSuiteBaselines, 'record' | 'findAmong'>;
}

/** How long the engine waits for the hosts it asked for before it goes on with the ones that came (design section 5). */
export const HOST_WAIT_MS = 10 * 60_000;
const HOST_POLL_MS = 5_000;
/** The demand row lives 120 s unless asked again; the engine asks again at this pace while the run lives. */
const DEMAND_REFRESH_MS = 45_000;
const READ_TIMEOUT_MS = 60_000;
/** The re-run phase's own cap (design 9.4). */
export const RERUN_TIMEOUT_MS = 12 * 60_000;
/** The extra hosts of a run, beside the plan's shards 0..N-1: the fresh host an infra or unrun spec is retried on, and the template host of main. */
export const FRESH_HOST_SHARD = 62;
export const MAIN_HOST_SHARD = 63;
/** Attempts to get a main host before main is given up on (9.5). */
const MAIN_HOST_ATTEMPTS = 2;
/** A spec path the engine puts in a command: no character the shell would read. */
const SPEC_SAFE = /^[A-Za-z0-9_.\/@+-]{1,256}$/;

export interface FirstPassSpec {
    spec: string;
    shard: number;
    status: SuiteSpecStatus;
    /** The runner's own result: absent for a spec that did not run. */
    result?: SpecResult;
}

export interface SuiteOutcome {
    suiteRunId: string;
    state: SuiteRunState;
    /** The run was already finished when asked again: nothing ran. */
    replayed: boolean;
    firstPass: FirstPassSpec[];
    /** Whose fault each red test is (9.3); absent for a baseline, which is never classified. */
    classification?: Classification;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const answered = (r: StepResult | EnvError): r is StepResult => 'transport' in r && r.transport === 'ok';

/** `{specs}` filled: Cypress takes a comma list, Playwright the files as arguments. */
export const fillSpecs = (config: Pick<SuiteConfig, 'runner' | 'command'>, specs: readonly string[]): string => config.command.replace(/\{specs\}/g, specs.join(config.runner === 'cypress' ? ',' : ' '));

/** A runner reports a spec relative to its own directory or to the repository; the planned path is the one that is stored. */
function plannedNameOf(reported: string, planned: ReadonlySet<string>): string {
    if (planned.has(reported)) return reported;
    for (const p of planned) if (p.endsWith(`/${reported}`) || reported.endsWith(`/${p}`)) return p;
    return reported;
}

/** What a command run on a claim produced: the specs the runner reported and those it did not, with why. */
interface Ran {
    done: Map<string, SpecResult>;
    missing: Map<string, 'not_run' | 'infra'>;
}

/** The files of one run of a command, as the engine reads them. */
interface Collector {
    phase: SuitePhase;
    shard: number;
    claimId: string;
    planned: ReadonlySet<string>;
    done: Map<string, SpecResult>;
    seen: Set<string>;
    reads: number;
}

interface ShardRun {
    shard: number;
    planned: string[];
    claimId?: string;
    done: Map<string, SpecResult>;
    /** Specs that ended without a result, and why. */
    missing: Map<string, 'not_run' | 'infra'>;
}

interface RunCtx {
    req: RuntimeSuiteRequested;
    inputs: SuiteInputs;
    side: 'pr' | 'base';
    sha: string;
    stats: SpecStats;
    shards: Map<number, ShardRun>;
    /** Every claim the run holds, released at the end. */
    claims: string[];
    /** The shards whose demand row is kept alive while the run lives. */
    demandShards: Set<number>;
    lastDemandAt: number;
}

/** The test's last failed attempt as a signature: what makes two failures "the same". */
const signatureOf = (t: TestResult) => errorSignature([...t.attempts].reverse().find((a) => a.status === 'failed')?.error);

export class SuiteEngine {
    constructor(private readonly d: SuiteEngineDeps) {}

    async run(req: RuntimeSuiteRequested, inputs: SuiteInputs): Promise<SuiteOutcome> {
        const { runs, clock } = this.d;
        const created = await runs.create({
            suiteRunId: req.suiteRunId,
            organizationId: req.organizationId,
            environmentId: req.environmentId,
            repositoryId: req.repositoryId,
            mode: req.mode,
            ...(req.prNumber !== undefined ? { prNumber: req.prNumber } : {}),
            ...(req.prSha ? { prSha: req.prSha } : {}),
            ...(req.mergeBase ? { mergeBase: req.mergeBase } : {}),
            mainSha: req.mainSha,
            requestedAt: new Date(req.requestedAt),
        });
        if (!created.created) {
            const held = await runs.get(req.organizationId, req.suiteRunId);
            if (held?.finishedAt) return { suiteRunId: req.suiteRunId, state: held.state, replayed: true, firstPass: [] };
        }
        const side = req.mode === 'baseline' ? 'base' : 'pr';
        const ctx: RunCtx = {
            req,
            inputs,
            side,
            sha: side === 'base' ? req.mainSha : (req.prSha as string),
            stats: await this.d.stats.read({ organizationId: req.organizationId, environmentId: req.environmentId }, inputs.specs.map((s) => s.path)),
            shards: new Map(),
            claims: [],
            demandShards: new Set(),
            lastDemandAt: clock.now(),
        };
        try {
            await this.firstPass(ctx);
            const firstPass = this.firstPassOf(ctx);
            const classification = req.mode === 'baseline' ? undefined : await this.rerunPhase(ctx, firstPass);
            return await this.conclude(ctx, firstPass, classification);
        } finally {
            await this.cleanup(ctx);
        }
    }

    // ---- plan, hosts

    private async firstPass(ctx: RunCtx): Promise<void> {
        const { req, inputs } = ctx;
        const headroom = (await this.d.headroom?.()) ?? Number.MAX_SAFE_INTEGER;
        const wanted = shardCount({ totalMs: estimateTotalMs(inputs.specs, ctx.stats), maxShards: inputs.config.maxShards, headroom, specCount: inputs.specs.length });
        const asked = hostsToAsk(wanted, headroom);
        const shards = Array.from({ length: asked }, (_, i) => i);
        const first = balanceSpecs(inputs.specs, ctx.stats, asked);
        await this.d.runs.savePlan(req.organizationId, req.suiteRunId, first.bins.map((b, i) => ({ shard: i, specs: b.specs })));
        await this.requestDemand(ctx, shards);

        const ready = await this.waitForHosts(ctx, shards);
        const plan = ready.length === 0 ? [] : spreadOnto(inputs.specs, ctx.stats, ready);
        if (plan.length > 0 && ready.length !== asked) await this.d.runs.savePlan(req.organizationId, req.suiteRunId, [...plan, ...shards.filter((s) => !ready.includes(s)).map((shard) => ({ shard, specs: [] as string[] }))]);
        // No host came at all: every spec is infra, on shard 0, for the fresh-host retry.
        const runs: ShardRun[] = (plan.length === 0 ? [{ shard: 0, specs: inputs.specs.map((s) => s.path) }] : plan).map((p) => ({ shard: p.shard, planned: p.specs, done: new Map(), missing: new Map() }));
        for (const r of runs) ctx.shards.set(r.shard, r);
        ctx.demandShards = new Set(plan.length === 0 ? [] : ready);
        if (plan.length === 0) {
            for (const p of runs[0].planned) runs[0].missing.set(p, 'infra');
        } else {
            await Promise.all(runs.map((r) => this.driveShard(ctx, r)));
        }
        await this.recordMissing(ctx);
    }

    private async requestDemand(ctx: RunCtx, shards: readonly number[]): Promise<void> {
        await this.d.demand.request({ organizationId: ctx.req.organizationId, environmentId: ctx.req.environmentId, suiteRunId: ctx.req.suiteRunId, shards });
        ctx.lastDemandAt = this.d.clock.now();
    }

    private async keepDemand(ctx: RunCtx): Promise<void> {
        if (this.d.clock.now() - ctx.lastDemandAt < DEMAND_REFRESH_MS || ctx.demandShards.size === 0) return;
        await this.requestDemand(ctx, [...ctx.demandShards]);
    }

    /** The shards whose host is up; waits until each asked shard is up or failed, or the wait runs out. */
    private async waitForHosts(ctx: RunCtx, asked: readonly number[]): Promise<number[]> {
        const { clock } = this.d;
        const deadline = clock.now() + HOST_WAIT_MS;
        for (;;) {
            const status = await this.d.demand.status();
            const state = (s: number) => status.find((h) => h.shard === s)?.state ?? 'starting';
            if (asked.every((s) => state(s) !== 'starting') || clock.now() >= deadline) return asked.filter((s) => state(s) === 'ready');
            await clock.sleep(HOST_POLL_MS);
            await this.keepDemand(ctx);
        }
    }

    /** One more host beside the plan's (the fresh host, main's): its demand row, its wait, its claim. Undefined when it did not come or was blocked. */
    private async extraHost(ctx: RunCtx, shard: number, side: 'pr' | 'base', sha: string, attempt: number): Promise<string | undefined> {
        const { req } = ctx;
        ctx.demandShards.add(shard);
        await this.requestDemand(ctx, [shard]);
        if (!(await this.waitForHosts(ctx, [shard])).includes(shard)) return undefined;
        const claim = await this.d.env.acquire({
            organizationId: req.organizationId,
            environmentId: req.environmentId,
            runId: req.suiteRunId,
            ref: { side, sha },
            consumer: 'suite',
            idempotencyKey: `suite:${req.suiteRunId}:${shard}:${attempt}`,
            suiteRunId: req.suiteRunId,
            shard,
        });
        if (isBlocked(claim)) return undefined;
        ctx.claims.push(claim.claimId);
        return claim.claimId;
    }

    // ---- one shard

    private async driveShard(ctx: RunCtx, shard: ShardRun): Promise<void> {
        const { req, inputs } = ctx;
        const runnable = shard.planned.filter((s) => SPEC_SAFE.test(s));
        for (const s of shard.planned) if (!SPEC_SAFE.test(s)) shard.missing.set(s, 'not_run');
        if (runnable.length === 0) return;
        const claim = await this.d.env.acquire({
            organizationId: req.organizationId,
            environmentId: req.environmentId,
            runId: req.suiteRunId,
            ref: { side: ctx.side, sha: ctx.sha },
            consumer: 'suite',
            idempotencyKey: `suite:${req.suiteRunId}:${shard.shard}`,
            suiteRunId: req.suiteRunId,
            shard: shard.shard,
        });
        if (isBlocked(claim)) {
            for (const s of runnable) shard.missing.set(s, 'infra');
            return;
        }
        shard.claimId = claim.claimId;
        ctx.claims.push(claim.claimId);
        const durations = estimateDurations(inputs.specs, ctx.stats);
        const ordered = orderBin(runnable, { failedBefore: [], diffCoverage: {}, durations: Object.fromEntries(durations ?? []) });
        // A crash re-runs what the runner had not reported, once, in the same claim.
        const ran = await this.runSpecs(ctx, { claimId: claim.claimId, shard: shard.shard }, 'shard', ordered, `${req.suiteRunId}-${shard.shard}`, { timeoutMs: inputs.config.shardTimeoutMs, crashRetries: 1, clear: false });
        for (const [spec, r] of ran.done) shard.done.set(spec, r);
        for (const [spec, why] of ran.missing) shard.missing.set(spec, why);
    }

    /**
     * Runs `specs` in a claim and reads what the runner reports. A crashed runner is asked again for what it had not
     * reported (`crashRetries` times, in the same claim); a shard past its timeout, a finished command that left a
     * spec out and a runner or host that never reported are `not_run` and `infra`, never a failure.
     */
    private async runSpecs(ctx: RunCtx, host: { claimId: string; shard: number }, phase: SuitePhase, specs: readonly string[], keyBase: string, o: { timeoutMs: number; crashRetries: number; clear: boolean }): Promise<Ran> {
        const col: Collector = { phase, shard: host.shard, claimId: host.claimId, planned: new Set(specs), done: new Map(), seen: new Set(), reads: 0 };
        const missing = new Map<string, 'not_run' | 'infra'>();
        // A re-run starts from an empty results directory: the runner writes the same file names again.
        if (o.clear) await this.clearResults(ctx, host.claimId, keyBase);
        let remaining = [...specs];
        for (let attempt = 0; attempt <= o.crashRetries && remaining.length > 0; attempt++) {
            const out = await this.runCommand(ctx, col, remaining, attempt === 0 ? keyBase : `${keyBase}-r${attempt}`, o.timeoutMs);
            remaining = remaining.filter((s) => !col.done.has(s));
            if (out.outcome === 'finished' || out.outcome === 'timeout') {
                for (const s of remaining) missing.set(s, 'not_run');
                return { done: col.done, missing };
            }
            if (out.outcome === 'infra') {
                for (const s of remaining) missing.set(s, 'infra');
                return { done: col.done, missing };
            }
            // crashed: the loop asks once more for what is left.
        }
        for (const s of remaining) missing.set(s, 'infra');
        return { done: col.done, missing };
    }

    private async clearResults(ctx: RunCtx, claimId: string, key: string): Promise<void> {
        const { config } = ctx.inputs;
        await this.d.env.exec(claimId, { stepId: `${key}:clear`, command: `rm -f -- ${config.resultsGlob}`, ...(config.cwd ? { cwd: config.cwd } : {}), timeoutMs: READ_TIMEOUT_MS });
    }

    private async runCommand(ctx: RunCtx, col: Collector, specs: readonly string[], key: string, timeoutMs: number): Promise<DetachedOutcome> {
        const { config } = ctx.inputs;
        const out = await runDetached({
            env: this.d.env,
            claimId: col.claimId,
            key,
            command: fillSpecs(config, specs),
            ...(config.cwd ? { cwd: config.cwd } : {}),
            envVars: config.env,
            resultsGlob: config.resultsGlob,
            timeoutMs,
            now: this.d.clock.now,
            sleep: this.d.clock.sleep,
            onPoll: async (p) => {
                await this.ingest(ctx, col, p.resultFiles, key);
                await this.keepDemand(ctx);
            },
        });
        // What the command wrote last, between the final poll and its end.
        if (out.outcome !== 'infra') await this.ingest(ctx, col, out.resultFiles, key);
        return out;
    }

    /** Reads the result files not read yet, parses them and stores each spec's result. A file that cannot be read or parsed yet is tried again at the next poll. */
    private async ingest(ctx: RunCtx, col: Collector, files: readonly string[], key: string): Promise<void> {
        const fresh: SpecResult[] = [];
        for (const f of files) {
            if (col.seen.has(f)) continue;
            const r = await this.d.env.exec(col.claimId, { stepId: `${key}:read:${++col.reads}`, command: `cat -- ${quote(f)}`, ...(ctx.inputs.config.cwd ? { cwd: ctx.inputs.config.cwd } : {}), timeoutMs: READ_TIMEOUT_MS });
            if (!answered(r) || r.exitCode !== 0 || r.truncated) continue;
            let parsed: SpecResult[];
            try {
                parsed = f.endsWith('.json') ? parseMochawesome(r.stdout) : parseJUnit(r.stdout);
            } catch {
                continue;
            }
            col.seen.add(f);
            for (const p of parsed) {
                const spec = plannedNameOf(p.spec, col.planned);
                // A file of an earlier run in the same directory, or a spec this run was not asked for, is not this run's result.
                if (!col.planned.has(spec) || col.done.has(spec)) continue;
                const result = { ...p, spec };
                col.done.set(spec, result);
                fresh.push(result);
            }
        }
        if (fresh.length === 0) return;
        await this.d.runs.recordResults(ctx.req.organizationId, ctx.req.suiteRunId, { phase: col.phase, shard: col.shard }, fresh.map((r) => ({ spec: r.spec, status: r.status, durationMs: r.durationMs, ...(r.errorSignature ? { errorSignature: r.errorSignature } : {}), tests: r.tests })));
    }

    private async recordMissing(ctx: RunCtx, phase: SuitePhase = 'shard', shards: Iterable<{ shard: number; missing: ReadonlyMap<string, 'not_run' | 'infra'> }> = ctx.shards.values()): Promise<void> {
        for (const shard of shards) {
            if (shard.missing.size === 0) continue;
            await this.d.runs.recordResults(
                ctx.req.organizationId,
                ctx.req.suiteRunId,
                { phase, shard: shard.shard },
                [...shard.missing].map(([spec, status]) => ({ spec, status, durationMs: 0, tests: [] })),
            );
        }
    }

    private firstPassOf(ctx: RunCtx): FirstPassSpec[] {
        const out: FirstPassSpec[] = [];
        for (const shard of ctx.shards.values()) {
            for (const spec of shard.planned) {
                const result = shard.done.get(spec);
                if (result) out.push({ spec, shard: shard.shard, status: result.status, result });
                else out.push({ spec, shard: shard.shard, status: shard.missing.get(spec) ?? 'not_run' });
            }
        }
        return out;
    }

    // ---- the re-run phase (section 9)

    private async rerunPhase(ctx: RunCtx, firstPass: FirstPassSpec[]): Promise<Classification> {
        const { req, inputs } = ctx;

        // 9.2: a spec that never reported (a lost shard, a crashed runner, a timeout) runs once more on a fresh host.
        const unreported = firstPass.filter((s) => s.status === 'infra' || s.status === 'not_run');
        const infraWas = new Map(unreported.filter((s) => s.status === 'infra').map((s) => [s.spec, s]));
        const fresh = unreported.length > 0 ? await this.freshHostPass(ctx, unreported.map((s) => s.spec)) : undefined;
        if (fresh) {
            for (const entry of firstPass) {
                const r = fresh.ran.done.get(entry.spec);
                if (r && (entry.status === 'infra' || entry.status === 'not_run')) Object.assign(entry, { shard: FRESH_HOST_SHARD, status: r.status, result: r });
            }
        }

        // The failures: tests that failed, and the specs that stayed infra (a recovered one is informational).
        const failures: SuiteFailure[] = [];
        for (const entry of firstPass) {
            if (entry.status === 'failed') {
                for (const t of entry.result!.tests.filter((x) => x.status === 'failed')) failures.push({ spec: entry.spec, title: t.title, kind: 'test', timedOut: false, errorSignature: signatureOf(t) });
            }
        }
        const infraRerun: Record<string, Rerun> = {};
        for (const spec of infraWas.keys()) {
            failures.push({ spec, title: '', kind: 'infra', timedOut: false, errorSignature: '' });
            infraRerun[testKey(spec, '')] = fresh?.ran.done.has(spec) ? { result: 'passed' } : { result: 'infra' };
        }
        const notRunSpecs = firstPass.filter((s) => s.status === 'not_run').map((s) => s.spec);

        const ran = firstPass.filter((s) => s.status === 'passed' || s.status === 'failed' || s.status === 'skipped').length;
        const testFailures = failures.filter((f) => f.kind === 'test');
        const plan = planReruns({ specsRun: ran, failures: testFailures });
        const rerunSpecs = new Set(plan.rerunSpecs);
        const { baseline, baseDrift } = await this.baselineOf(ctx);

        let prRerun: Record<string, Rerun> = {};
        let main: Parameters<typeof classifyFailures>[0]['main'] = { state: 'ran', results: {} };
        if (rerunSpecs.size > 0) {
            const wanted = testFailures.filter((f) => rerunSpecs.has(f.spec));
            const usable = !!baseline && baseline.exactMergeBase && baseline.digestMatches && baseline.commitsBehindMain <= BASELINE_MAX_COMMITS_BEHIND;
            let mainSide: Awaited<ReturnType<SuiteEngine['mainRerun']>>;
            let mainWanted = wanted;
            if (usable) {
                // A baseline that already says what the PR says saves the main run: the PR goes first, main only for the rest (8.1).
                prRerun = this.rerunsOf(wanted, (await this.prRerun(ctx, firstPass, [...rerunSpecs])).ran);
                mainWanted = wanted.filter((f) => prRerun[testKey(f.spec, f.title)]?.result === 'failed' && needsMainRerun(f, prRerun[testKey(f.spec, f.title)], baseline));
                const specs = [...new Set(mainWanted.map((f) => f.spec))];
                mainSide = specs.length > 0 ? await this.mainRerun(ctx, specs) : { state: 'ran', ran: { done: new Map(), missing: new Map() } };
                if (specs.length === 0) mainWanted = [];
            } else {
                // The PR re-run and the main re-run go at the same time (9.3).
                const [pr, m] = await Promise.all([this.prRerun(ctx, firstPass, [...rerunSpecs]), this.mainRerun(ctx, [...rerunSpecs])]);
                prRerun = this.rerunsOf(wanted, pr.ran);
                mainSide = m;
                mainWanted = wanted.filter((f) => prRerun[testKey(f.spec, f.title)]?.result === 'failed');
            }
            main = mainSide.state === 'ran' ? { state: 'ran', results: this.rerunsOf(mainWanted, mainSide.ran, mainSide.ran.done.size === 0 && mainSide.ran.missing.size > 0) } : { state: mainSide.state };
        }

        const classification = classifyFailures({
            failures,
            plan,
            prRerun,
            infraRerun,
            main,
            baseDrift,
            diffReachedSpecs: inputs.diffReachedSpecs ?? [],
            ...(baseline ? { baseline } : {}),
            notRunSpecs,
        });
        if (classification.requestTemplateBuild) await this.d.templates?.requestBuild?.(req.organizationId, req.environmentId).catch(() => undefined);
        return classification;
    }

    private digestOf(ctx: RunCtx): string {
        return ctx.inputs.suiteDigest ?? suiteDigestOf(ctx.inputs.config, ctx.inputs.specs.map((s) => s.path));
    }

    /**
     * The merge base's baseline as the classifier reads it (7.1, 9.5), and how far main is ahead of the merge base. The
     * lookup is the merge base first, then its ancestors; the classifier decides whether what it found is evidence (only the
     * exact merge base, fresh enough). Without a history the drift is what the request says.
     */
    private async baselineOf(ctx: RunCtx): Promise<{ baseline?: BaselineEvidence; baseDrift: number }> {
        const { req, inputs } = ctx;
        const history = inputs.mainHistory;
        const at = history && req.mergeBase ? history.indexOf(req.mergeBase) : -1;
        // A merge base older than the history we hold: main is further ahead than we can count.
        const baseDrift = inputs.baseDrift ?? (history && req.mergeBase ? (at >= 0 ? at : history.length) : 0);
        if (!this.d.baselines || !history || at < 0) return { baseDrift };
        const found = await this.d.baselines.findAmong(req.organizationId, req.environmentId, this.digestOf(ctx), history.slice(at));
        if (!found) return { baseDrift };
        const specs: Record<string, { status: 'passed' | 'failed'; errorSignature?: string }> = {};
        // A skipped spec says nothing about whether it passes.
        for (const [spec, b] of Object.entries(found.specs)) if (b.status !== 'skipped') specs[spec] = { status: b.status, ...(b.errorSignature ? { errorSignature: b.errorSignature } : {}) };
        return {
            baseDrift,
            baseline: { sha: found.mainSha, exactMergeBase: found.mainSha === req.mergeBase, commitsBehindMain: history.indexOf(found.mainSha), digestMatches: found.suiteDigest === this.digestOf(ctx), specs },
        };
    }

    /** The specs that never reported, once more, on a host of their own that holds the PR build. */
    private async freshHostPass(ctx: RunCtx, specs: readonly string[]): Promise<{ ran: Ran } | undefined> {
        const claimId = await this.extraHost(ctx, FRESH_HOST_SHARD, 'pr', ctx.sha, 0);
        const runnable = specs.filter((s) => SPEC_SAFE.test(s));
        if (!claimId || runnable.length === 0) return undefined;
        const ran = await this.runSpecs(ctx, { claimId, shard: FRESH_HOST_SHARD }, 'shard', runnable, `${ctx.req.suiteRunId}-${FRESH_HOST_SHARD}`, { timeoutMs: ctx.inputs.config.shardTimeoutMs, crashRetries: 0, clear: false });
        ctx.shards.set(FRESH_HOST_SHARD, { shard: FRESH_HOST_SHARD, planned: runnable, claimId, done: ran.done, missing: ran.missing });
        await this.recordMissing(ctx, 'shard', [{ shard: FRESH_HOST_SHARD, missing: ran.missing }]);
        return { ran };
    }

    /** The failed specs again on the PR, each on the shard host that ran it first (it holds the PR build): no new host, no build. */
    private async prRerun(ctx: RunCtx, firstPass: readonly FirstPassSpec[], specs: readonly string[]): Promise<{ ran: Ran }> {
        const done = new Map<string, SpecResult>();
        const missing = new Map<string, 'not_run' | 'infra'>();
        const byShard = new Map<number, string[]>();
        for (const spec of specs) {
            const shard = firstPass.find((s) => s.spec === spec)?.shard;
            if (shard !== undefined) byShard.set(shard, [...(byShard.get(shard) ?? []), spec]);
        }
        await Promise.all(
            [...byShard].map(async ([shard, list]) => {
                const claimId = ctx.shards.get(shard)?.claimId;
                if (!claimId) return void list.forEach((s) => missing.set(s, 'infra'));
                const ran = await this.runSpecs(ctx, { claimId, shard }, 'rerun_pr', list, `${ctx.req.suiteRunId}-${shard}-rerun`, { timeoutMs: RERUN_TIMEOUT_MS, crashRetries: 0, clear: true });
                for (const [k, v] of ran.done) done.set(k, v);
                for (const [k, v] of ran.missing) missing.set(k, v);
                await this.recordMissing(ctx, 'rerun_pr', [{ shard, missing: ran.missing }]);
            }),
        );
        return { ran: { done, missing } };
    }

    /** The failed specs on main: a template host, no build. No template, or no host in two attempts, and main is not waited for (9.5). */
    private async mainRerun(ctx: RunCtx, specs: readonly string[]): Promise<{ state: 'ran'; ran: Ran } | { state: 'template_missing' } | { state: 'no_host' }> {
        const { req } = ctx;
        if (this.d.templates && !(await this.d.templates.hasReady(req.organizationId, req.environmentId))) return { state: 'template_missing' };
        for (let attempt = 0; attempt < MAIN_HOST_ATTEMPTS; attempt++) {
            const claimId = await this.extraHost(ctx, MAIN_HOST_SHARD, 'base', req.mainSha, attempt);
            if (!claimId) continue;
            const ran = await this.runSpecs(ctx, { claimId, shard: MAIN_HOST_SHARD }, 'rerun_main', specs, `${req.suiteRunId}-${MAIN_HOST_SHARD}`, { timeoutMs: RERUN_TIMEOUT_MS, crashRetries: 0, clear: false });
            await this.recordMissing(ctx, 'rerun_main', [{ shard: MAIN_HOST_SHARD, missing: ran.missing }]);
            return { state: 'ran', ran };
        }
        return { state: 'no_host' };
    }

    /** What a re-run said of each failed test: its test in the re-run spec result, else why the spec has none. */
    private rerunsOf(failures: readonly SuiteFailure[], ran: Ran, hostLost = false): Record<string, Rerun> {
        const out: Record<string, Rerun> = {};
        for (const f of failures) {
            const spec = ran.done.get(f.spec);
            if (!spec) {
                const why = ran.missing.get(f.spec);
                out[testKey(f.spec, f.title)] = hostLost || why === 'infra' ? { result: 'infra' } : { result: 'not_run' };
                continue;
            }
            const t = spec.tests.find((x) => x.title === f.title);
            if (!t) out[testKey(f.spec, f.title)] = { result: 'not_run' };
            else if (t.status === 'failed') out[testKey(f.spec, f.title)] = { result: 'failed', errorSignature: signatureOf(t), timedOut: false };
            else out[testKey(f.spec, f.title)] = { result: 'passed' };
        }
        return out;
    }

    // ---- the end

    private async conclude(ctx: RunCtx, firstPass: FirstPassSpec[], classification: Classification | undefined): Promise<SuiteOutcome> {
        await this.d.stats.record(
            { organizationId: ctx.req.organizationId, environmentId: ctx.req.environmentId },
            ctx.sha,
            firstPass.filter((s) => s.result).map((s) => ({ spec: s.spec, status: s.result!.status, durationMs: s.result!.durationMs })),
        );
        if (ctx.req.mode === 'baseline') await this.recordBaseline(ctx, firstPass);
        const state = this.stateOf(ctx, firstPass, classification);
        await this.d.runs.finish(ctx.req.organizationId, ctx.req.suiteRunId, state, new Date(this.d.clock.now()));
        return { suiteRunId: ctx.req.suiteRunId, state, replayed: false, firstPass, ...(classification ? { classification } : {}) };
    }

    /** The whole suite on main, per spec as it ended. Complete only when every spec reported; an incomplete one is no baseline for a lookup. */
    private async recordBaseline(ctx: RunCtx, firstPass: readonly FirstPassSpec[]): Promise<void> {
        if (!this.d.baselines) return;
        const specs: Record<string, BaselineSpec> = {};
        for (const s of firstPass) {
            if (s.result) specs[s.spec] = { status: s.result.status, durationMs: s.result.durationMs, ...(s.result.errorSignature ? { errorSignature: s.result.errorSignature } : {}) };
        }
        await this.d.baselines.record({
            organizationId: ctx.req.organizationId,
            environmentId: ctx.req.environmentId,
            mainSha: ctx.req.mainSha,
            suiteDigest: this.digestOf(ctx),
            status: firstPass.length > 0 && firstPass.every((s) => s.result) ? 'complete' : 'incomplete',
            specs,
            finishedAt: new Date(this.d.clock.now()),
        });
    }

    /**
     * D4: a regression fails the run; flaky, pre-existing and recovered infra never do; anything unconfirmed or
     * unclassified with no regression is neutral, and fails with the strict gate. A baseline has no classification:
     * a red spec is a result of main, and a spec that never ran leaves it neutral.
     */
    private stateOf(ctx: RunCtx, firstPass: FirstPassSpec[], classification: Classification | undefined): SuiteRunState {
        if (!classification) return firstPass.some((s) => s.status === 'failed') ? 'failed' : firstPass.some((s) => s.status === 'not_run' || s.status === 'infra') ? 'neutral' : 'passed';
        if (classification.tests.some((t) => t.class === 'regression')) return 'failed';
        const unknown = classification.tests.some((t) => t.class === 'unclassified' || t.class === 'failed_unconfirmed' || t.class === 'regression_unconfirmed' || t.class === 'regression_probable');
        if (!unknown) return 'passed';
        return ctx.inputs.config.gate === 'strict' ? 'failed' : 'neutral';
    }

    private async cleanup(ctx: RunCtx): Promise<void> {
        for (const claimId of ctx.claims) await this.d.env.release(claimId).catch(() => undefined);
        await this.d.demand.end().catch(() => undefined);
    }
}
