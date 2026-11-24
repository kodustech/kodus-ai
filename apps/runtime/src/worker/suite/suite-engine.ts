import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { type EnvironmentRuntime, isBlocked } from '@libs/runtime/environment';
import type { EnvError, StepResult } from '@libs/runtime/environment';
import { balanceSpecs, estimateDurations, estimateTotalMs, hostsToAsk, orderBin, parseJUnit, parseMochawesome, shardCount, spreadOnto, type SpecResult, type SpecStats, type SuiteSpecFile } from '@libs/runtime/suite';

import { type DetachedOutcome, runDetached } from './detached-exec';
import type { PgSuiteRuns, SuiteRunState, SuiteSpecStatus } from './pg-suite-runs';
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
}

export interface SuiteInputs {
    config: SuiteConfig;
    /** The spec files this run executes, relative to `config.cwd` (the whole suite, or the selection). */
    specs: readonly SuiteSpecFile[];
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
}

/** How long the engine waits for the hosts it asked for before it goes on with the ones that came (design section 5). */
export const HOST_WAIT_MS = 10 * 60_000;
const HOST_POLL_MS = 5_000;
/** The demand row lives 120 s unless asked again; the engine asks again at this pace while the run lives. */
const DEMAND_REFRESH_MS = 45_000;
const READ_TIMEOUT_MS = 60_000;
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

interface ShardRun {
    shard: number;
    planned: string[];
    claimId?: string;
    /** What the runner reported, by planned spec name. */
    done: Map<string, SpecResult>;
    seenFiles: Set<string>;
    reads: number;
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
    lastDemandAt: number;
}

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
            lastDemandAt: clock.now(),
        };
        try {
            await this.firstPass(ctx);
            return await this.conclude(ctx);
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
        // No host came at all: every spec is infra, on shard 0, for the classifier's fresh-host retry.
        const runs: ShardRun[] = (plan.length === 0 ? [{ shard: 0, specs: inputs.specs.map((s) => s.path) }] : plan).map((p) => ({ shard: p.shard, planned: p.specs, done: new Map(), seenFiles: new Set(), reads: 0, missing: new Map() }));
        for (const r of runs) ctx.shards.set(r.shard, r);
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
        if (this.d.clock.now() - ctx.lastDemandAt < DEMAND_REFRESH_MS) return;
        await this.requestDemand(ctx, [...ctx.shards.keys()]);
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
        const durations = estimateDurations(inputs.specs, ctx.stats);
        const ordered = orderBin(runnable, { failedBefore: [], diffCoverage: {}, durations: Object.fromEntries(durations ?? []) });

        // A crash re-runs what the runner had not reported, once, in the same claim.
        let remaining = ordered;
        for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt++) {
            const out = await this.runCommand(ctx, shard, remaining, attempt === 0 ? `${req.suiteRunId}-${shard.shard}` : `${req.suiteRunId}-${shard.shard}-r${attempt}`);
            remaining = remaining.filter((s) => !shard.done.has(s));
            if (out.outcome === 'finished') {
                for (const s of remaining) shard.missing.set(s, 'not_run');
                return;
            }
            if (out.outcome === 'timeout') {
                for (const s of remaining) shard.missing.set(s, 'not_run');
                return;
            }
            if (out.outcome === 'infra') {
                for (const s of remaining) shard.missing.set(s, 'infra');
                return;
            }
            // crashed: the loop asks once more for what is left.
        }
        for (const s of remaining) shard.missing.set(s, 'infra');
    }

    private async runCommand(ctx: RunCtx, shard: ShardRun, specs: readonly string[], key: string): Promise<DetachedOutcome> {
        const { config } = ctx.inputs;
        const out = await runDetached({
            env: this.d.env,
            claimId: shard.claimId as string,
            key,
            command: fillSpecs(config, specs),
            ...(config.cwd ? { cwd: config.cwd } : {}),
            envVars: config.env,
            resultsGlob: config.resultsGlob,
            timeoutMs: config.shardTimeoutMs,
            now: this.d.clock.now,
            sleep: this.d.clock.sleep,
            onPoll: async (p) => {
                await this.ingest(ctx, shard, p.resultFiles, key);
                await this.keepDemand(ctx);
            },
        });
        // What the command wrote last, between the final poll and its end.
        if (out.outcome !== 'infra') await this.ingest(ctx, shard, out.resultFiles, key);
        return out;
    }

    /** Reads the result files not read yet, parses them and stores each spec's result. A file that cannot be read or parsed yet is tried again at the next poll. */
    private async ingest(ctx: RunCtx, shard: ShardRun, files: readonly string[], key: string): Promise<void> {
        const planned = new Set(shard.planned);
        const fresh: SpecResult[] = [];
        for (const f of files) {
            if (shard.seenFiles.has(f)) continue;
            const r = await this.d.env.exec(shard.claimId as string, { stepId: `${key}:read:${++shard.reads}`, command: `cat -- ${quote(f)}`, ...(ctx.inputs.config.cwd ? { cwd: ctx.inputs.config.cwd } : {}), timeoutMs: READ_TIMEOUT_MS });
            if (!answered(r) || r.exitCode !== 0 || r.truncated) continue;
            let parsed: SpecResult[];
            try {
                parsed = f.endsWith('.json') ? parseMochawesome(r.stdout) : parseJUnit(r.stdout);
            } catch {
                continue;
            }
            shard.seenFiles.add(f);
            for (const p of parsed) {
                const spec = plannedNameOf(p.spec, planned);
                if (shard.done.has(spec)) continue;
                const result = { ...p, spec };
                shard.done.set(spec, result);
                fresh.push(result);
            }
        }
        if (fresh.length === 0) return;
        await this.d.runs.recordResults(ctx.req.organizationId, ctx.req.suiteRunId, { phase: 'shard', shard: shard.shard }, fresh.map((r) => ({ spec: r.spec, status: r.status, durationMs: r.durationMs, ...(r.errorSignature ? { errorSignature: r.errorSignature } : {}), tests: r.tests })));
    }

    private async recordMissing(ctx: RunCtx): Promise<void> {
        for (const shard of ctx.shards.values()) {
            if (shard.missing.size === 0) continue;
            await this.d.runs.recordResults(
                ctx.req.organizationId,
                ctx.req.suiteRunId,
                { phase: 'shard', shard: shard.shard },
                [...shard.missing].map(([spec, status]) => ({ spec, status, durationMs: 0, tests: [] })),
            );
        }
    }

    // ---- the end

    private async conclude(ctx: RunCtx): Promise<SuiteOutcome> {
        const firstPass: FirstPassSpec[] = [];
        for (const shard of ctx.shards.values()) {
            for (const spec of shard.planned) {
                const result = shard.done.get(spec);
                if (result) firstPass.push({ spec, shard: shard.shard, status: result.status, result });
                else firstPass.push({ spec, shard: shard.shard, status: shard.missing.get(spec) ?? 'not_run' });
            }
        }
        await this.d.stats.record(
            { organizationId: ctx.req.organizationId, environmentId: ctx.req.environmentId },
            ctx.sha,
            firstPass.filter((s) => s.result).map((s) => ({ spec: s.spec, status: s.result!.status, durationMs: s.result!.durationMs })),
        );
        const state: SuiteRunState = firstPass.some((s) => s.status === 'failed') ? 'failed' : firstPass.some((s) => s.status === 'not_run' || s.status === 'infra') ? 'neutral' : 'passed';
        await this.d.runs.finish(ctx.req.organizationId, ctx.req.suiteRunId, state, new Date(this.d.clock.now()));
        return { suiteRunId: ctx.req.suiteRunId, state, replayed: false, firstPass };
    }

    private async cleanup(ctx: RunCtx): Promise<void> {
        for (const shard of ctx.shards.values()) if (shard.claimId) await this.d.env.release(shard.claimId).catch(() => undefined);
        await this.d.demand.end().catch(() => undefined);
    }
}
