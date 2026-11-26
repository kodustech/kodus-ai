import { SUITE_ARTIFACT_BUDGET_BYTES } from '@libs/runtime/contracts/evidence';
import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { type AcquireRequest, type Blocked, type Claim, type EnvironmentRuntime, isBlocked } from '@libs/runtime/environment';
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
    failFast,
    hostsToAsk,
    needsMainRerun,
    orderBin,
    parseJUnit,
    parseMochawesome,
    perSpecOverheadMs,
    planReruns,
    type Rerun,
    shardCount,
    shardTargetMs,
    spreadOnto,
    suiteDigestOf,
    type SpecResult,
    type SpecStats,
    type SuiteFailure,
    type SuiteSelectionReport,
    type SuiteSpecFile,
    testKey,
    type TestResult,
} from '@libs/runtime/suite';

import { collectCoverage, type CoverageMapRecord, coverageDirOf } from './coverage-collector';
import { type DetachedOutcome, runDetached, safeResultsGlob } from './detached-exec';
import type { BaselineSpec, PgSuiteBaselines } from './pg-suite-baselines';
import type { PgSuiteRuns, SuitePhase, SuiteRunState, SuiteSpecStatus } from './pg-suite-runs';
import type { PgSuiteSpecStats } from './pg-suite-spec-stats';
import type { SuiteArtifactKeeper } from './suite-artifacts';
import { cleanSpecResult } from './result-hygiene';
import { execInService } from './suite-environment';
import type { Canary } from '../canary/canary';
import type { SuiteShardHost } from '../../shared/persistence/suite-demand';
import { acquireWaitingForRoom } from '../env/capacity-wait';

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
    /** `suite.results.artifacts`: the directories the runner writes screenshots, videos and traces to; the artifacts of failed specs are kept from them. */
    artifacts?: readonly string[];
    /** `suite.service`: the compose service every command of the suite runs in (the command, its polls and kill, the result, artifact and coverage reads). Absent: the recipe's public service. */
    service?: string;
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
    /** How the specs were chosen (the whole suite with the reason, or the selection): kept on the run for its check. */
    selection?: SuiteSelectionReport;
    /**
     * When the suite must be over, as the clock's `now()` counts (epoch ms): a suite that runs as a stage of a Run (Run mode) shares
     * the Run's 45 minutes (design 12.1), so no wait, command or re-run goes past it; what did not run is `not_run`. Absent: only the recipe's own caps.
     */
    deadlineAt?: number;
    /**
     * Aborted when the suite is cancelled (a newer push on the PR, the PR closed, the Run stopped): every command is stopped, no
     * claim is taken after it, nothing is re-run or classified, and the run ends `cancelled` with its claims and demand released.
     */
    signal?: AbortSignal;
    /** The risk-first order inside a shard (6.1): the specs red on the previous push first, then those that cover the diff. The balance is untouched. */
    order?: { failedBefore: readonly string[]; diffCoverage: Readonly<Record<string, number>> };
    /**
     * A baseline collects the files each spec exercises (6.1, D10): each spec runs as a command of its own, alone against the
     * service, with `NODE_V8_COVERAGE` set, and the map is recorded with the baseline. Ignored in a PR run, which never pays for it.
     */
    coverage?: boolean;
    /** The Run's canaries when the suite is a stage of a Run: one in an artifact halts the suite (section 13). */
    canaries?: readonly Canary[];
    /** The bytes of artifacts the run keeps in all; absent: `SUITE_ARTIFACT_BUDGET_BYTES` (200 MiB). */
    artifactBudgetBytes?: number;
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
    runs: Pick<PgSuiteRuns, 'create' | 'get' | 'finish' | 'savePlan' | 'recordResults' | 'recordArtifacts'> & Partial<Pick<PgSuiteRuns, 'markShard'>>;
    stats: Pick<PgSuiteSpecStats, 'read' | 'record'>;
    demand: SuiteHostDemand;
    clock: { now(): number; sleep(ms: number): Promise<void> };
    /** How many hosts the pool can start now; absent: no limit but the suite's own ceiling. */
    headroom?(): Promise<number>;
    /** Absent: a template is taken to be ready. */
    templates?: SuiteTemplates;
    /** The baselines of main commits: a baseline run records one, a PR run reads the one of its merge base. Absent: none is kept or used. */
    baselines?: Pick<PgSuiteBaselines, 'record' | 'findAmong'>;
    /** Where a baseline's coverage map is kept; absent: none is kept. */
    maps?: { record(m: CoverageMapRecord): Promise<{ stored: boolean }> };
    /** Keeps the artifacts of failed specs as evidence; absent: none are kept. */
    artifacts?: Pick<SuiteArtifactKeeper, 'keep'>;
}

/** How long the engine waits for the hosts it asked for before it goes on with the ones that came (design section 5). */
export const HOST_WAIT_MS = 10 * 60_000;

/**
 * A suite claim on its own perRun host. The fleet reports a host ready once its cell registered, which can be before
 * the cell told the hub its room: the reservation then answers "no capacity, host starting". A refusal for room is a
 * pause (ADR-070), so it is asked again with the same idempotency key until `until`, as every other claim does.
 */
export async function acquireSuiteClaim(
    env: Pick<EnvironmentRuntime, 'acquire'>,
    req: AcquireRequest,
    clock: { now(): number; sleep(ms: number): Promise<void> },
    until: number,
): Promise<Claim | Blocked> {
    return (await acquireWaitingForRoom(env, req, { until, now: () => new Date(clock.now()), sleep: (ms) => clock.sleep(ms) })).claim;
}
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
    /** A canary was found in an artifact: the suite stopped, and a Run that holds it halts (section 13). */
    leaked?: boolean;
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

/** The longest cause stored with an `infra` spec. */
const MAX_INFRA_CAUSE = 300;
const ERROR_LINE = /error|missing|not found|cannot|failed|denied|refused|killed/i;

/**
 * Why a runner reported nothing, in one line: the reason, the exit status and the last line of its log that names an
 * error (else its last line). Every spec of the shard was stored `infra` with nothing more, so a suite that never ran
 * (a Cypress binary the image left out, kr-mono on dev) gave the person nothing to act on.
 */
export function infraCause(reason: string, exitCode: number | undefined, logTail: string | undefined): string {
    const lines = (logTail ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const line = [...lines].reverse().find((l) => ERROR_LINE.test(l)) ?? lines.at(-1);
    return `${reason}${exitCode !== undefined ? ` (exit ${exitCode})` : ''}${line ? `: ${line}` : ''}`.slice(0, MAX_INFRA_CAUSE);
}

/** What a command run on a claim produced: the specs the runner reported and those it did not, with why. */
interface Ran {
    done: Map<string, SpecResult>;
    missing: Map<string, 'not_run' | 'infra'>;
    /** Why the runner reported nothing for the `infra` specs: the reason, the exit status and its last error line. */
    cause?: string;
}

/** The files of one run of a command, as the engine reads them. */
interface Collector {
    phase: SuitePhase;
    shard: number;
    claimId: string;
    /** Added to the command's environment (a baseline's coverage directory). */
    env?: Record<string, string>;
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
    /** Why the runner reported nothing (Ran.cause), stored with each `infra` spec. */
    cause?: string;
    /** When the shard's claim turned ready, and when its last result was read: the wall time the stats learn each spec's cost from. */
    startedAt?: number;
    lastResultAt?: number;
    /** The claim was refused: its specs stay up for the siblings, and are `infra` if none takes them. */
    blocked?: boolean;
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
    /** Specs in the order they finished in the first pass, across shards: what fail fast reads (6.1). */
    finished: Array<{ spec: string; failed: boolean }>;
    /** Aborted when fail fast stops the first pass: every shard's command is stopped. */
    stop: AbortController;
    /** The specs fail fast left unrun: they are `not_run` and are not given a fresh host either. */
    skipped: Set<string>;
    /** What the PR run was judged against: the baseline it could use (7.1) and how far main was ahead of the merge base (8.2). */
    judged?: { baselineSha?: string; baseDrift: number };
    /** The files each spec exercised, read from its dumps (a baseline with coverage only); a spec whose dumps could not be read is absent. */
    coverage: Map<string, string[]>;
    /** The artifact bytes kept so far, and the chain that keeps shards' reservations in order. */
    artifactBytes: number;
    artifactChain: Promise<void>;
    /** A canary was found in an artifact. */
    leaked: boolean;
    /**
     * The specs of shards whose command has not started (the claim is still booting, or was refused), by the shard that owns them. A
     * shard that finishes early takes a share of them and runs them on the PR build it holds; the late shard then runs what is left.
     */
    pending: Map<string, number>;
    /** Resolved when every spec of a shard was taken by a sibling: its claim is no longer waited for. */
    drained: Map<number, () => void>;
    cleaned: boolean;
    /** The time the run's hosts were held, summed over hosts (a baseline and a first pass count as `firstPass`). */
    hostMs: { firstPass: number; rerun: number };
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
            ...(inputs.selection ? { selection: inputs.selection } : {}),
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
            finished: [],
            stop: new AbortController(),
            skipped: new Set(),
            coverage: new Map(),
            artifactBytes: 0,
            artifactChain: Promise.resolve(),
            leaked: false,
            pending: new Map(),
            drained: new Map(),
            cleaned: false,
            hostMs: { firstPass: 0, rerun: 0 },
        };
        try {
            await this.firstPass(ctx);
            const firstPass = this.firstPassOf(ctx);
            // A canary in an artifact halts the suite: nothing is re-run or judged.
            if (ctx.leaked) return await this.concludeLeaked(ctx, firstPass);
            // Cancelled: what ran is stored as it ran; nothing is re-run or judged.
            if (this.cancelled(ctx)) return await this.concludeCancelled(ctx, firstPass);
            const classification = req.mode === 'baseline' ? undefined : await this.rerunPhase(ctx, firstPass);
            if (this.cancelled(ctx)) return await this.concludeCancelled(ctx, firstPass);
            return await this.conclude(ctx, firstPass, classification);
        } finally {
            await this.cleanup(ctx);
        }
    }

    /** Runs `work` and adds the time it held a host to the run's machine time: `firstPass` for the shards, `rerun` for everything after. */
    private async held<T>(ctx: RunCtx, kind: 'firstPass' | 'rerun', work: () => Promise<T>): Promise<T> {
        const at = this.d.clock.now();
        try {
            return await work();
        } finally {
            ctx.hostMs[kind] += Math.max(0, this.d.clock.now() - at);
        }
    }

    /** What a run ends with beside its state: the machine time it measured. */
    private machineOf(ctx: RunCtx) {
        return { firstPassMs: Math.round(ctx.hostMs.firstPass), rerunMs: Math.round(ctx.hostMs.rerun) };
    }

    // ---- plan, hosts

    private async firstPass(ctx: RunCtx): Promise<void> {
        const { req, inputs } = ctx;
        const headroom = (await this.d.headroom?.()) ?? Number.MAX_SAFE_INTEGER;
        // The stored times are the wall time a spec costs a shard, the runner's own start included (stats are learned that way, see `conclude`).
        const timeLeftMs = inputs.deadlineAt !== undefined ? inputs.deadlineAt - clockNow(this.d) : undefined;
        const wanted = shardCount({
            totalMs: estimateTotalMs(inputs.specs, ctx.stats),
            maxShards: inputs.config.maxShards,
            headroom,
            specCount: inputs.specs.length,
            targetShardMs: shardTargetMs({ shardTimeoutMs: inputs.config.shardTimeoutMs, ...(timeLeftMs !== undefined ? { timeLeftMs } : {}) }),
        });
        const asked = hostsToAsk(wanted, headroom);
        const shards = Array.from({ length: asked }, (_, i) => i);
        const first = balanceSpecs(inputs.specs, ctx.stats, asked);
        await this.d.runs.savePlan(req.organizationId, req.suiteRunId, first.bins.map((b, i) => ({ shard: i, specs: b.specs })));
        await this.requestDemand(ctx, shards);
        // Asked again while the hosts come: a demand row lasts 120 s, and a host that registers after it lapsed is ended
        // as served the moment it is ready. Narrowed to the hosts that came once the wait ends.
        ctx.demandShards = new Set(shards);

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
            for (const r of runs) for (const spec of r.planned) ctx.pending.set(spec, r.shard);
            await Promise.all(runs.map(async (r) => {
                await this.held(ctx, 'firstPass', async () => {
                    await this.driveShard(ctx, r);
                    await this.keepArtifacts(ctx, r);
                });
            }));
        }
        // What no shard took: a shard whose claim was refused leaves its specs `infra` (the fresh host retries them), the rest `not_run`.
        for (const [spec, owner] of ctx.pending) {
            const shard = ctx.shards.get(owner);
            if (shard && !shard.missing.has(spec)) shard.missing.set(spec, shard.blocked ? 'infra' : 'not_run');
        }
        ctx.pending.clear();
        await this.recordMissing(ctx);
    }

    /**
     * The artifacts of the shard's failed specs (7, D8), read while the shard's claim is still held and before a re-run can
     * overwrite them: a PR run only, and only when the recipe names the directories. Shards take the budget in turn. A keeper that
     * fails loses the artifacts, never the result. A canary found stops every shard's command and ends the run (13).
     */
    private keepArtifacts(ctx: RunCtx, shard: ShardRun): Promise<void> {
        const keeper = this.d.artifacts;
        const dirs = ctx.inputs.config.artifacts ?? [];
        const failed = [...shard.done].filter(([, r]) => r.status === 'failed').map(([spec]) => spec);
        if (!keeper || dirs.length === 0 || ctx.req.mode === 'baseline' || ctx.req.mode === 'shadow' || !shard.claimId || failed.length === 0) return Promise.resolve();
        const claimId = shard.claimId;
        const turn = ctx.artifactChain.then(async () => {
            const remaining = (ctx.inputs.artifactBudgetBytes ?? SUITE_ARTIFACT_BUDGET_BYTES) - ctx.artifactBytes;
            const kept = await keeper
                .keep({
                    organizationId: ctx.req.organizationId,
                    suiteRunId: ctx.req.suiteRunId,
                    side: ctx.side,
                    shard: shard.shard,
                    claimId,
                    ...(ctx.inputs.config.cwd ? { cwd: ctx.inputs.config.cwd } : {}),
                    dirs,
                    specs: shard.planned,
                    failed,
                    remainingBytes: Math.max(0, remaining),
                    ...(ctx.inputs.canaries?.length ? { canaries: ctx.inputs.canaries } : {}),
                })
                .catch(() => undefined);
            if (!kept) return;
            ctx.artifactBytes += kept.keptBytes;
            const bySpec = new Map<string, Array<{ name: string; key: string; contentType: string; bytes: number }>>();
            for (const a of kept.artifacts) bySpec.set(a.spec, [...(bySpec.get(a.spec) ?? []), { name: a.name, key: a.key, contentType: a.contentType, bytes: a.bytes }]);
            if (bySpec.size > 0) await this.d.runs.recordArtifacts(ctx.req.organizationId, ctx.req.suiteRunId, { phase: 'shard', shard: shard.shard }, [...bySpec].map(([spec, artifacts]) => ({ spec, artifacts }))).catch(() => undefined);
            if (kept.leaked) {
                ctx.leaked = true;
                ctx.stop.abort();
            }
        });
        ctx.artifactChain = turn.catch(() => undefined);
        return turn;
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
        const deadline = Math.min(clock.now() + HOST_WAIT_MS, ctx.inputs.deadlineAt ?? Infinity);
        for (;;) {
            const status = await this.d.demand.status();
            const state = (s: number) => status.find((h) => h.shard === s)?.state ?? 'starting';
            if (ctx.inputs.signal?.aborted) return [];
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
        if (!(await this.waitForHosts(ctx, [shard])).includes(shard) || this.cancelled(ctx)) return undefined;
        const claim = await acquireSuiteClaim(this.d.env, {
            organizationId: req.organizationId,
            environmentId: req.environmentId,
            runId: req.suiteRunId,
            ref: { side, sha },
            consumer: 'suite',
            idempotencyKey: `suite:${req.suiteRunId}:${shard}:${attempt}`,
            suiteRunId: req.suiteRunId,
            shard,
        }, this.d.clock, this.claimDeadline(ctx));
        if (isBlocked(claim)) return undefined;
        ctx.claims.push(claim.claimId);
        return claim.claimId;
    }

    /** How long a shard's claim may wait for room on its host: the host wait, never past the suite's deadline. */
    private claimDeadline(ctx: RunCtx): number {
        return Math.min(this.d.clock.now() + HOST_WAIT_MS, ctx.inputs.deadlineAt ?? Infinity);
    }

    // ---- one shard

    private async driveShard(ctx: RunCtx, shard: ShardRun): Promise<void> {
        const { req } = ctx;
        for (const s of shard.planned) {
            if (!SPEC_SAFE.test(s)) {
                shard.missing.set(s, 'not_run');
                ctx.pending.delete(s);
            }
        }
        if (shard.planned.every((s) => !SPEC_SAFE.test(s))) return;
        // Fail fast stopped the first pass before this shard got its host: no claim, nothing runs.
        if (ctx.stop.signal.aborted || this.cancelled(ctx)) {
            for (const s of shard.planned) if (SPEC_SAFE.test(s)) shard.missing.set(s, 'not_run');
            for (const s of shard.planned) ctx.pending.delete(s);
            return;
        }
        const acquiring = acquireSuiteClaim(this.d.env, {
            organizationId: req.organizationId,
            environmentId: req.environmentId,
            runId: req.suiteRunId,
            ref: { side: ctx.side, sha: ctx.sha },
            consumer: 'suite',
            idempotencyKey: `suite:${req.suiteRunId}:${shard.shard}`,
            suiteRunId: req.suiteRunId,
            shard: shard.shard,
        }, this.d.clock, this.claimDeadline(ctx));
        // A claim that boots for long (the PR build on its host) is not waited for once siblings have taken all of its specs.
        const drained = new Promise<'drained'>((resolve) => ctx.drained.set(shard.shard, () => resolve('drained')));
        const claim = await Promise.race([acquiring, drained]);
        if (claim === 'drained') {
            // It still comes up some day: released the moment it does.
            void acquiring.then((c) => this.adopt(ctx, c, false)).catch(() => undefined);
            return;
        }
        if (isBlocked(claim)) {
            // Its specs stay up for the siblings that are still running; what nobody takes is `infra` at the end of the pass.
            shard.blocked = true;
            return;
        }
        this.adopt(ctx, claim, true);
        shard.claimId = claim.claimId;
        shard.startedAt = this.d.clock.now();
        // What a sibling took while the claim booted is theirs; the rest is this shard's from now on.
        for (const s of shard.planned) ctx.pending.delete(s);
        const runnable = shard.planned.filter((s) => SPEC_SAFE.test(s));
        // The claim is ready (the app is up on the host): from here to the end is the shard's own time, as the page shows it.
        await this.markShard(ctx, shard.shard, 'running');
        try {
            if (runnable.length > 0) await this.runShard(ctx, shard, claim.claimId, runnable);
            await this.stealPending(ctx, shard, claim.claimId);
        } finally {
            await this.markShard(ctx, shard.shard, 'finished');
        }
    }

    /** A claim that came up: held (and released at the end), or, after the run ended or when it is not wanted, released now. */
    private adopt(ctx: RunCtx, claim: Claim | Blocked, wanted: boolean): void {
        if (isBlocked(claim)) return;
        if (wanted && !ctx.cleaned) ctx.claims.push(claim.claimId);
        else void this.d.env.release(claim.claimId).catch(() => undefined);
    }

    /**
     * A shard that finished its own specs takes half of the specs of shards whose command has not started, and runs them in its claim
     * (it holds the PR build): a host that boots late no longer leaves its specs `not_run` while the siblings sit idle. It goes on while
     * the shard's own cap and the suite's deadline leave time, and takes nothing once the run is cut short.
     */
    private async stealPending(ctx: RunCtx, shard: ShardRun, claimId: string): Promise<void> {
        if (this.collectsCoverage(ctx)) return;
        for (let round = 1; ; round++) {
            if (ctx.stop.signal.aborted || this.cancelled(ctx) || ctx.leaked) return;
            const left = Math.min(ctx.inputs.config.shardTimeoutMs - (this.d.clock.now() - (shard.startedAt ?? this.d.clock.now())), (ctx.inputs.deadlineAt ?? Infinity) - this.d.clock.now());
            if (left <= 0 || ctx.pending.size === 0) return;
            const taken = this.takeShare(ctx, shard);
            if (taken.length === 0) return;
            await this.d.runs.savePlan(ctx.req.organizationId, ctx.req.suiteRunId, [...ctx.shards.values()].map((s) => ({ shard: s.shard, specs: s.planned })));
            const durations = estimateDurations(ctx.inputs.specs, ctx.stats);
            const ordered = orderBin(taken, { failedBefore: ctx.inputs.order?.failedBefore ?? [], diffCoverage: ctx.inputs.order?.diffCoverage ?? {}, durations: Object.fromEntries(durations ?? []) });
            const ran = await this.runSpecs(ctx, { claimId, shard: shard.shard }, 'shard', ordered, `${ctx.req.suiteRunId}-${shard.shard}-t${round}`, { timeoutMs: left, crashRetries: 1, clear: false });
            for (const [spec, r] of ran.done) shard.done.set(spec, r);
            for (const [spec, why] of ran.missing) shard.missing.set(spec, why);
            if (ran.cause) shard.cause = ran.cause;
        }
    }

    /** Half of the pending specs (every other one, longest first, so both halves weigh alike; the last one whole), moved to `shard`'s plan. */
    private takeShare(ctx: RunCtx, shard: ShardRun): string[] {
        const durations = estimateDurations(ctx.inputs.specs, ctx.stats);
        const weight = (s: string) => durations?.get(s) ?? 0;
        const pending = [...ctx.pending.keys()].filter((s) => SPEC_SAFE.test(s)).sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
        const taken = pending.length === 1 ? pending : pending.filter((_, i) => i % 2 === 0);
        for (const spec of taken) {
            const owner = ctx.shards.get(ctx.pending.get(spec)!);
            ctx.pending.delete(spec);
            if (owner) owner.planned = owner.planned.filter((s) => s !== spec);
            shard.planned.push(spec);
            if (owner && owner.planned.length === 0) ctx.drained.get(owner.shard)?.();
        }
        return taken;
    }

    /** When a shard's claim was ready and when its specs ended: best effort, a failed write never fails the run. */
    private async markShard(ctx: RunCtx, shard: number, moment: 'running' | 'finished'): Promise<void> {
        await this.d.runs.markShard?.(ctx.req.organizationId, ctx.req.suiteRunId, shard, moment, new Date(this.d.clock.now())).catch(() => undefined);
    }

    private async runShard(ctx: RunCtx, shard: ShardRun, claimId: string, runnable: readonly string[]): Promise<void> {
        const { req, inputs } = ctx;
        const durations = estimateDurations(inputs.specs, ctx.stats);
        const ordered = orderBin(runnable, { failedBefore: inputs.order?.failedBefore ?? [], diffCoverage: inputs.order?.diffCoverage ?? {}, durations: Object.fromEntries(durations ?? []) });
        if (this.collectsCoverage(ctx)) return this.driveShardWithCoverage(ctx, shard, claimId, ordered);
        // A crash re-runs what the runner had not reported, once, in the same claim.
        const ran = await this.runSpecs(ctx, { claimId, shard: shard.shard }, 'shard', ordered, `${req.suiteRunId}-${shard.shard}`, { timeoutMs: inputs.config.shardTimeoutMs, crashRetries: 1, clear: false });
        for (const [spec, r] of ran.done) shard.done.set(spec, r);
        for (const [spec, why] of ran.missing) shard.missing.set(spec, why);
        if (ran.cause) shard.cause = ran.cause;
    }

    /** Only a baseline collects: a PR run never sets `NODE_V8_COVERAGE` and never runs a spec alone for it. */
    private collectsCoverage(ctx: RunCtx): boolean {
        return ctx.req.mode === 'baseline' && ctx.inputs.coverage === true;
    }

    /**
     * A baseline shard with coverage: each spec is a command of its own, one after the other (a service never sees two specs at
     * once, so the dumps of a spec are its own), with `NODE_V8_COVERAGE` on a directory of that spec; its dumps are read and
     * removed when the command ends. The shard's cap is shared by all of them. A spec whose dumps cannot be read has no entry:
     * the map is then incomplete, never guessed.
     */
    private async driveShardWithCoverage(ctx: RunCtx, shard: ShardRun, claimId: string, ordered: readonly string[]): Promise<void> {
        const { req, inputs } = ctx;
        const startedAt = this.d.clock.now();
        for (const [i, spec] of ordered.entries()) {
            const key = `${req.suiteRunId}-${shard.shard}-c${i}`;
            const left = inputs.config.shardTimeoutMs - (this.d.clock.now() - startedAt);
            if (left <= 0) {
                shard.missing.set(spec, 'not_run');
                continue;
            }
            const dir = coverageDirOf(key);
            const ran = await this.runSpecs(ctx, { claimId, shard: shard.shard }, 'shard', [spec], key, { timeoutMs: left, crashRetries: 1, clear: false, env: { NODE_V8_COVERAGE: dir } });
            for (const [s, r] of ran.done) shard.done.set(s, r);
            for (const [s, why] of ran.missing) shard.missing.set(s, why);
            if (ran.cause) shard.cause = ran.cause;
            if (!ran.done.has(spec)) continue;
            const files = await collectCoverage(this.execIn(inputs.config), claimId, key, dir);
            if (files) ctx.coverage.set(spec, files);
        }
    }

    /**
     * Runs `specs` in a claim and reads what the runner reports. A crashed runner is asked again for what it had not
     * reported (`crashRetries` times, in the same claim); a shard past its timeout, a finished command that left a
     * spec out and a runner or host that never reported are `not_run` and `infra`, never a failure.
     */
    private async runSpecs(ctx: RunCtx, host: { claimId: string; shard: number }, phase: SuitePhase, specs: readonly string[], keyBase: string, o: { timeoutMs: number; crashRetries: number; clear: boolean; env?: Record<string, string> }): Promise<Ran> {
        const col: Collector = { phase, shard: host.shard, claimId: host.claimId, ...(o.env ? { env: o.env } : {}), planned: new Set(specs), done: new Map(), seen: new Set(), reads: 0 };
        const missing = new Map<string, 'not_run' | 'infra'>();
        // A re-run starts from an empty results directory: the runner writes the same file names again.
        if (o.clear) await this.clearResults(ctx, host.claimId, keyBase);
        let remaining = [...specs];
        let cause: string | undefined;
        for (let attempt = 0; attempt <= o.crashRetries && remaining.length > 0; attempt++) {
            // Time the run may still use: past its deadline nothing starts, and a command is cut at it.
            const timeoutMs = Math.min(o.timeoutMs, (ctx.inputs.deadlineAt ?? Infinity) - this.d.clock.now());
            if (timeoutMs <= 0) {
                for (const s of remaining) missing.set(s, 'not_run');
                return { done: col.done, missing };
            }
            const out = await this.runCommand(ctx, col, remaining, attempt === 0 ? keyBase : `${keyBase}-r${attempt}`, timeoutMs);
            remaining = remaining.filter((s) => !col.done.has(s));
            if (out.outcome === 'finished' || out.outcome === 'timeout' || out.outcome === 'cancelled') {
                for (const s of remaining) missing.set(s, 'not_run');
                return { done: col.done, missing };
            }
            if (out.outcome === 'infra') {
                for (const s of remaining) missing.set(s, 'infra');
                return { done: col.done, missing, cause: infraCause(out.reason, out.exitCode, out.logTail) };
            }
            // crashed: the loop asks once more for what is left.
            cause = infraCause('crashed', undefined, out.logTail);
        }
        for (const s of remaining) missing.set(s, 'infra');
        return { done: col.done, missing, ...(cause ? { cause } : {}) };
    }

    /** The environment's exec for the suite's commands: in the recipe's service when it names one. */
    private execIn(config: Pick<SuiteConfig, 'service'>): Pick<EnvironmentRuntime, 'exec'> {
        return execInService(this.d.env, config.service);
    }

    private async clearResults(ctx: RunCtx, claimId: string, key: string): Promise<void> {
        const { config } = ctx.inputs;
        // The glob goes into a shell unquoted (it must expand): only a plain path pattern inside the cwd ever reaches it.
        if (!safeResultsGlob(config.resultsGlob)) return;
        await this.execIn(config).exec(claimId, { stepId: `${key}:clear`, command: `rm -f -- ${config.resultsGlob}`, ...(config.cwd ? { cwd: config.cwd } : {}), timeoutMs: READ_TIMEOUT_MS });
    }

    private async runCommand(ctx: RunCtx, col: Collector, specs: readonly string[], key: string, timeoutMs: number): Promise<DetachedOutcome> {
        const { config } = ctx.inputs;
        const out = await runDetached({
            env: this.d.env,
            claimId: col.claimId,
            ...(config.service ? { service: config.service } : {}),
            key,
            command: fillSpecs(config, specs),
            ...(config.cwd ? { cwd: config.cwd } : {}),
            envVars: { ...config.env, ...col.env },
            resultsGlob: config.resultsGlob,
            timeoutMs,
            // Only the first pass is cut short by fail fast; the fresh host and the re-runs go on after it.
            ...this.signalOf(ctx, col),
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
            const r = await this.execIn(ctx.inputs.config).exec(col.claimId, { stepId: `${key}:read:${++col.reads}`, command: `cat -- ${quote(f)}`, ...(ctx.inputs.config.cwd ? { cwd: ctx.inputs.config.cwd } : {}), timeoutMs: READ_TIMEOUT_MS });
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
                // Titles and errors are the customer's code talking: redacted and bounded before anything stores them; a canary halts the suite.
                const { result, leaked } = cleanSpecResult({ ...p, spec }, ctx.inputs.canaries ?? []);
                if (leaked) ctx.leaked = true;
                col.done.set(spec, result);
                fresh.push(result);
                if (this.failsFast(ctx, col)) ctx.finished.push({ spec, failed: result.status === 'failed' });
            }
        }
        if (fresh.length === 0) return;
        const first = col.phase === 'shard' && col.shard !== FRESH_HOST_SHARD ? ctx.shards.get(col.shard) : undefined;
        if (first) first.lastResultAt = this.d.clock.now();
        await this.d.runs.recordResults(ctx.req.organizationId, ctx.req.suiteRunId, { phase: col.phase, shard: col.shard }, fresh.map((r) => ({ spec: r.spec, status: r.status, durationMs: r.durationMs, ...(r.errorSignature ? { errorSignature: r.errorSignature } : {}), tests: r.tests })));
        this.checkFailFast(ctx, col);
    }

    private cancelled(ctx: RunCtx): boolean {
        return !!ctx.inputs.signal?.aborted;
    }

    /** What stops a command: the cancel of the whole suite, and, in the first pass of a PR run, fail fast. */
    private signalOf(ctx: RunCtx, col: Pick<Collector, 'phase' | 'shard'>): { signal?: AbortSignal } {
        const signals = [ctx.inputs.signal, this.failsFast(ctx, col) ? ctx.stop.signal : undefined].filter((x): x is AbortSignal => !!x);
        return signals.length === 0 ? {} : { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) };
    }

    /** Fail fast reads the first pass of a PR run's shards only: not the fresh host, the re-runs, or a baseline (which must be complete). */
    private failsFast(ctx: RunCtx, col: Pick<Collector, 'phase' | 'shard'>): boolean {
        return ctx.req.mode !== 'baseline' && col.phase === 'shard' && col.shard !== FRESH_HOST_SHARD;
    }

    /** More than 25% of the first batch red: stop every shard's command; what did not run is `not_run` and the classifier sees a mass failure (6.1). */
    private checkFailFast(ctx: RunCtx, col: Pick<Collector, 'phase' | 'shard'>): void {
        if (!this.failsFast(ctx, col) || ctx.stop.signal.aborted) return;
        const decision = failFast({ allSpecs: ctx.inputs.specs.map((s) => s.path), finished: ctx.finished });
        if (!decision.stop) return;
        for (const spec of decision.notRun) ctx.skipped.add(spec);
        ctx.stop.abort();
    }

    private async recordMissing(ctx: RunCtx, phase: SuitePhase = 'shard', shards: Iterable<{ shard: number; missing: ReadonlyMap<string, 'not_run' | 'infra'>; cause?: string }> = ctx.shards.values()): Promise<void> {
        for (const shard of shards) {
            if (shard.missing.size === 0) continue;
            // The runner's own words are the customer's code talking: redacted and bounded like a failure message (result-hygiene).
            const cause = shard.cause ? cleanSpecResult({ spec: '', status: 'failed', durationMs: 0, tests: [], errorSignature: shard.cause }, ctx.inputs.canaries ?? []).result.errorSignature : undefined;
            await this.d.runs.recordResults(
                ctx.req.organizationId,
                ctx.req.suiteRunId,
                { phase, shard: shard.shard },
                [...shard.missing].map(([spec, status]) => ({ spec, status, durationMs: 0, tests: [], ...(status === 'infra' && cause ? { errorSignature: cause } : {}) })),
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
        const unreported = firstPass.filter((s) => (s.status === 'infra' || s.status === 'not_run') && !ctx.skipped.has(s.spec));
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
        const { baseline, baseDrift } = await this.baselineOf(ctx);
        const usableBaseline = !!baseline && baseline.exactMergeBase && baseline.digestMatches && baseline.commitsBehindMain <= BASELINE_MAX_COMMITS_BEHIND;
        // What main already fails (the usable baseline) is not this PR's mass failure.
        const failingOnMain = usableBaseline ? new Set(Object.entries(baseline!.specs).filter(([, r]) => r.status === 'failed').map(([spec]) => spec)) : undefined;
        const plan = planReruns({ specsRun: ran, failures: testFailures, ...(failingOnMain ? { failingOnMain } : {}) });
        const rerunSpecs = new Set(plan.rerunSpecs);
        ctx.judged = { ...(usableBaseline ? { baselineSha: baseline!.sha } : {}), baseDrift };

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
        const at = this.d.clock.now();
        const claimId = await this.extraHost(ctx, FRESH_HOST_SHARD, 'pr', ctx.sha, 0);
        const runnable = specs.filter((s) => SPEC_SAFE.test(s));
        if (!claimId || runnable.length === 0) return undefined;
        const ran = await this.runSpecs(ctx, { claimId, shard: FRESH_HOST_SHARD }, 'shard', runnable, `${ctx.req.suiteRunId}-${FRESH_HOST_SHARD}`, { timeoutMs: ctx.inputs.config.shardTimeoutMs, crashRetries: 0, clear: false });
        ctx.hostMs.rerun += Math.max(0, this.d.clock.now() - at);
        ctx.shards.set(FRESH_HOST_SHARD, { shard: FRESH_HOST_SHARD, planned: runnable, claimId, done: ran.done, missing: ran.missing });
        await this.recordMissing(ctx, 'shard', [{ shard: FRESH_HOST_SHARD, missing: ran.missing, ...(ran.cause ? { cause: ran.cause } : {}) }]);
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
                const ran = await this.held(ctx, 'rerun', () => this.runSpecs(ctx, { claimId, shard }, 'rerun_pr', list, `${ctx.req.suiteRunId}-${shard}-rerun`, { timeoutMs: RERUN_TIMEOUT_MS, crashRetries: 0, clear: true }));
                for (const [k, v] of ran.done) done.set(k, v);
                for (const [k, v] of ran.missing) missing.set(k, v);
                await this.recordMissing(ctx, 'rerun_pr', [{ shard, missing: ran.missing, ...(ran.cause ? { cause: ran.cause } : {}) }]);
            }),
        );
        return { ran: { done, missing } };
    }

    /** The failed specs on main: a template host, no build. No template, or no host in two attempts, and main is not waited for (9.5). */
    private async mainRerun(ctx: RunCtx, specs: readonly string[]): Promise<{ state: 'ran'; ran: Ran } | { state: 'template_missing' } | { state: 'no_host' }> {
        const { req } = ctx;
        if (this.d.templates && !(await this.d.templates.hasReady(req.organizationId, req.environmentId))) return { state: 'template_missing' };
        for (let attempt = 0; attempt < MAIN_HOST_ATTEMPTS; attempt++) {
            const at = this.d.clock.now();
            const claimId = await this.extraHost(ctx, MAIN_HOST_SHARD, 'base', req.mainSha, attempt);
            if (!claimId) continue;
            const ran = await this.runSpecs(ctx, { claimId, shard: MAIN_HOST_SHARD }, 'rerun_main', specs, `${req.suiteRunId}-${MAIN_HOST_SHARD}`, { timeoutMs: RERUN_TIMEOUT_MS, crashRetries: 0, clear: false });
            ctx.hostMs.rerun += Math.max(0, this.d.clock.now() - at);
            await this.recordMissing(ctx, 'rerun_main', [{ shard: MAIN_HOST_SHARD, missing: ran.missing, ...(ran.cause ? { cause: ran.cause } : {}) }]);
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
            this.wallObservations(ctx, firstPass),
        );
        if (ctx.req.mode === 'baseline') {
            await this.recordBaseline(ctx, firstPass);
            await this.recordCoverageMap(ctx, firstPass);
        }
        const state = this.stateOf(ctx, firstPass, classification);
        await this.d.runs.finish(ctx.req.organizationId, ctx.req.suiteRunId, state, new Date(this.d.clock.now()), { ...this.machineOf(ctx), ...(classification ? { classification } : {}), ...(ctx.judged ? { ...(ctx.judged.baselineSha ? { baselineSha: ctx.judged.baselineSha } : {}), baseDrift: ctx.judged.baseDrift } : {}) });
        return { suiteRunId: ctx.req.suiteRunId, state, replayed: false, firstPass, ...(classification ? { classification } : {}) };
    }

    /**
     * What the stats learn: each spec at the wall time it cost its shard. The runner's report counts the spec's own run, not
     * its start (Cypress opens a browser per spec, slowly under gVisor), so the shard's wall time, from its claim ready to its
     * last result, less the durations it reported, is shared by the specs that reported: that is added to each spec's duration. A spec that ran
     * on the fresh host, or on a shard with nothing to measure, takes the average overhead of the shards that were measured.
     */
    private wallObservations(ctx: RunCtx, firstPass: readonly FirstPassSpec[]): Array<{ spec: string; status: SpecResult['status']; durationMs: number }> {
        const overheadOf = new Map<number, number>();
        for (const sh of ctx.shards.values()) {
            if (sh.shard === FRESH_HOST_SHARD || sh.startedAt === undefined || sh.lastResultAt === undefined || sh.done.size === 0) continue;
            overheadOf.set(sh.shard, perSpecOverheadMs({ wallMs: sh.lastResultAt - sh.startedAt, durationsMs: [...sh.done.values()].map((r) => r.durationMs) }));
        }
        const measured = [...overheadOf.values()];
        const average = measured.length > 0 ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : 0;
        return firstPass.filter((s) => s.result).map((s) => ({ spec: s.spec, status: s.result!.status, durationMs: s.result!.durationMs + (overheadOf.get(s.shard) ?? average) }));
    }

    /** A canary in an artifact ends the suite `failed` (a security event, never green or neutral): no classification, no baseline, no durations. */
    private async concludeLeaked(ctx: RunCtx, firstPass: FirstPassSpec[]): Promise<SuiteOutcome> {
        await this.d.runs.finish(ctx.req.organizationId, ctx.req.suiteRunId, 'failed', new Date(this.d.clock.now()), this.machineOf(ctx));
        return { suiteRunId: ctx.req.suiteRunId, state: 'failed', replayed: false, firstPass, leaked: true };
    }

    /** A cancelled suite ends `cancelled`: no classification, no baseline, no durations (a cut-short spec says nothing of how long it takes). */
    private async concludeCancelled(ctx: RunCtx, firstPass: FirstPassSpec[]): Promise<SuiteOutcome> {
        await this.d.runs.finish(ctx.req.organizationId, ctx.req.suiteRunId, 'cancelled', new Date(this.d.clock.now()), this.machineOf(ctx));
        return { suiteRunId: ctx.req.suiteRunId, state: 'cancelled', replayed: false, firstPass };
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

    /** The files each spec exercised on main, complete only when every spec of the suite reported and its dumps were read. */
    private async recordCoverageMap(ctx: RunCtx, firstPass: readonly FirstPassSpec[]): Promise<void> {
        if (!this.d.maps || !this.collectsCoverage(ctx)) return;
        const specs: Record<string, string[]> = {};
        for (const [spec, files] of ctx.coverage) specs[spec] = files;
        await this.d.maps.record({
            organizationId: ctx.req.organizationId,
            environmentId: ctx.req.environmentId,
            mainSha: ctx.req.mainSha,
            suiteDigest: this.digestOf(ctx),
            status: firstPass.length > 0 && firstPass.every((s) => ctx.coverage.has(s.spec)) ? 'complete' : 'incomplete',
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
        ctx.cleaned = true;
        for (const claimId of ctx.claims) await this.d.env.release(claimId).catch(() => undefined);
        await this.d.demand.end().catch(() => undefined);
    }
}

const clockNow = (d: Pick<SuiteEngineDeps, 'clock'>) => d.clock.now();
