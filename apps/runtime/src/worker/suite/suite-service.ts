import { type Claim } from '@libs/runtime/environment';
import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import { type CoverageMapInput, type PreviousSuiteRun, planSuiteRun, type SuiteSelectionReport, specListOf, suiteDigestOf } from '@libs/runtime/suite';

import type { PgSuiteBaselineRequests } from '../../shared/persistence/suite-baseline-requests';
import type { PgSuiteBaselines } from './pg-suite-baselines';
import type { PgSuiteRuns, SuiteRunState } from './pg-suite-runs';
import type { PgSuiteSpecStats } from './pg-suite-spec-stats';
import type { EnvironmentSetupStore } from '../setup/environment-setup.store';
import { mainHistoryOf } from './suite-adapters';
import { suiteConfigOf, type ResolvedSuite } from './suite-config';
import type { SuiteEnvironment } from './suite-environment';
import { type SuiteHostDemand, SuiteEngine, type SuiteTemplates } from './suite-engine';
import { TemplateSpecLister } from './spec-lister';
import type { SuitePublisher } from './suite-publisher';

export const SUITE_SERVICE = Symbol('SUITE_SERVICE');
/** The suite run store the worker's handlers and service read and write (`PgSuiteRuns`). */
export const SUITE_RUNS = Symbol('SUITE_RUNS');

/** A workflow step: its result is journalled, and a replay of the workflow takes the journalled result. */
export type SuiteStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** What the environment of one suite run is built from: its claims are of this repository, each with a token of its own. */
export interface SuiteEnvironmentContext {
    organizationId: string;
    suiteRunId: string;
    /** The command's key, which every token is sealed to. */
    key: string;
    correlationId: string;
    fullName: string;
    imageId: string;
    expose: Claim['manifest']['expose'];
    /** Sealed, the first claim's first. */
    tokens: string[];
}

export interface SuiteServiceDeps {
    setups: Pick<EnvironmentSetupStore, 'get'>;
    environment(ctx: SuiteEnvironmentContext): SuiteEnvironment;
    demand(scope: { organizationId: string; suiteRunId: string }): SuiteHostDemand;
    runs: Pick<PgSuiteRuns, 'create' | 'get' | 'finish' | 'savePlan' | 'recordResults' | 'latestForPr'>;
    stats: Pick<PgSuiteSpecStats, 'read' | 'record'>;
    baselines?: Pick<PgSuiteBaselines, 'record' | 'findAmong'>;
    templates?: SuiteTemplates;
    /** The environment's newest complete coverage map (a later step of the plan): absent, every PR run is the whole suite with the reason `map_missing`. */
    maps?: { newest(organizationId: string, environmentId: string): Promise<CoverageMapInput | undefined> };
    headroom?(): Promise<number>;
    /** The baseline request a baseline run answers: marked started once the workflow holds it, so the product does not issue it again. */
    baselineRequests?: Pick<PgSuiteBaselineRequests, 'markStarted'>;
    clock: { now(): number; sleep(ms: number): Promise<void> };
    /** The suite's check: opened when the run starts, closed with its conclusion. Absent: nothing is published. */
    publisher?: Pick<SuitePublisher, 'started' | 'finished'>;
}

export type SuiteServiceResult =
    /** The engine ran (or had run: `replayed`); `state` is the run's. */
    | { status: 'ran'; suiteRunId: string; state: SuiteRunState; replayed: boolean }
    /** The environment has no suite to run: no run row. */
    | { status: 'off'; reason: 'no_suite' | 'baseline_disabled' }
    /** The run could not start; it ended neutral, with the reason. */
    | { status: 'unavailable'; suiteRunId: string; state: 'neutral'; reason: 'template_missing' | 'no_host' | 'list_failed' | 'no_repository' | 'no_specs' };

interface Started {
    suite: ResolvedSuite;
    imageId: string;
    expose: Claim['manifest']['expose'];
}

/**
 * The body of the `runtime.suite` workflow (docs/runtime/e2e-suites.md section 11): read the recipe's suite block, list the
 * specs of main on a template host, put the PR's added and removed specs on the list, and run the engine. Two steps, so a
 * replay takes the recipe it read the first time. The engine is idempotent by suite run (a finished run is answered, a
 * claim is acquired by its key, a command starts once), so a step that runs again after a crash finishes what was left.
 */
export class SuiteService {
    constructor(private readonly d: SuiteServiceDeps) {}

    async run(cmd: RuntimeSuiteRequested, step: SuiteStep): Promise<SuiteServiceResult> {
        const started = await step('suite:start', () => this.start(cmd));
        if ('status' in started) return started;
        // Publish steps retry (run-engine.service.ts `isPublishStep`): a broker that restarts never ends the suite without its check.
        const publisher = this.d.publisher;
        if (publisher) await step('publish:suite-started', () => publisher.started(cmd));
        const result = await step('suite:run', () => this.runEngine(cmd, started));
        if (publisher) await step('publish:suite-final', () => publisher.finished(cmd, result, { ...(started.suite.config.cwd ? { cwd: started.suite.config.cwd } : {}) }));
        return result;
    }

    private async start(cmd: RuntimeSuiteRequested): Promise<Started | Extract<SuiteServiceResult, { status: 'off' }>> {
        // The baseline request is answered once a workflow holds it, whatever the recipe says: it is not asked for again.
        if (cmd.mode === 'baseline') await this.d.baselineRequests?.markStarted(cmd.organizationId, cmd.environmentId, cmd.mainSha).catch(() => undefined);
        const setup = await this.d.setups.get(cmd.environmentId);
        const content = setup?.organizationId === cmd.organizationId && setup.recipe?.state === 'found' ? setup.recipe.content : undefined;
        const parsed = content ? parseRecipe(content) : undefined;
        const suite = parsed?.ok ? suiteConfigOf(parsed.recipe) : undefined;
        if (!suite || !setup) return { status: 'off', reason: 'no_suite' };
        if (cmd.mode === 'baseline' && !suite.baseline) return { status: 'off', reason: 'baseline_disabled' };
        return { suite, imageId: setup.imageId ?? 'latest', expose: setup.expose ?? [] };
    }

    private async runEngine(cmd: RuntimeSuiteRequested, s: Started): Promise<SuiteServiceResult> {
        const { runs, clock } = this.d;
        const held = await runs.get(cmd.organizationId, cmd.suiteRunId);
        if (held?.finishedAt) return { status: 'ran', suiteRunId: cmd.suiteRunId, state: held.state, replayed: true };
        if (!cmd.repositoryFullName) return this.unavailable(cmd, 'no_repository');
        const tokens = [cmd.repoToken, ...(cmd.moreRepoTokens ?? [])].filter((t): t is string => !!t);
        const env = this.d.environment({
            organizationId: cmd.organizationId,
            suiteRunId: cmd.suiteRunId,
            key: cmd.key,
            correlationId: `suite-${cmd.suiteRunId}`,
            fullName: cmd.repositoryFullName,
            imageId: s.imageId,
            expose: s.expose,
            tokens,
        });
        const demand = this.d.demand({ organizationId: cmd.organizationId, suiteRunId: cmd.suiteRunId });
        const listing = await new TemplateSpecLister({ env, demand, ...(this.d.templates ? { templates: this.d.templates } : {}), clock }).list(
            { organizationId: cmd.organizationId, environmentId: cmd.environmentId, suiteRunId: cmd.suiteRunId, mainSha: cmd.mainSha },
            { ...(s.suite.config.cwd ? { cwd: s.suite.config.cwd } : {}), specsGlob: s.suite.specsGlob },
        );
        if (listing.status === 'unavailable') {
            await demand.end().catch(() => undefined);
            return this.unavailable(cmd, listing.reason);
        }
        const common = { glob: s.suite.specsGlob, ...(s.suite.config.cwd ? { cwd: s.suite.config.cwd } : {}), listed: listing.specs, changedFiles: cmd.changedFiles, removedFiles: cmd.removedFiles };
        // A baseline is main alone: the PR's files are not part of it.
        const whole = specListOf(cmd.mode === 'baseline' ? { glob: common.glob, listed: listing.specs, ...(common.cwd ? { cwd: common.cwd } : {}) } : common);
        const digest = suiteDigestOf(s.suite.config, whole.map((x) => x.path));
        const plan = await this.plan(cmd, s, whole.map((x) => x.path), digest);
        const wanted = new Set(plan.specs);
        // A retry runs exactly the specs it names; a selection runs the ones the plan chose (in the list's order).
        const specs = cmd.specs ? specListOf({ ...common, only: cmd.specs }) : whole.filter((x) => wanted.has(x.path));
        if (specs.length === 0 && !cmd.specs && plan.selection.mode === 'none') {
            // The change reaches no spec: green, and the check says none ran.
            await demand.end().catch(() => undefined);
            return this.endedWithoutRunning(cmd, 'passed', plan.selection);
        }
        if (specs.length === 0) {
            await demand.end().catch(() => undefined);
            return this.unavailable(cmd, 'no_specs');
        }
        const engine = new SuiteEngine({
            env,
            runs,
            stats: this.d.stats,
            demand,
            clock,
            ...(this.d.baselines ? { baselines: this.d.baselines } : {}),
            ...(this.d.templates ? { templates: this.d.templates } : {}),
            ...(this.d.headroom ? { headroom: this.d.headroom } : {}),
        });
        const out = await engine.run(cmd, {
            config: s.suite.config,
            specs,
            mainHistory: mainHistoryOf(cmd),
            // A retry or a selection runs part of the suite; the digest that keys a baseline is the whole suite's.
            suiteDigest: digest,
            selection: cmd.specs ? { mode: 'selected', selected: specs.length, total: whole.length } : plan.selection,
            order: { failedBefore: plan.failedBefore, diffCoverage: plan.diffCoverage },
        });
        return { status: 'ran', suiteRunId: cmd.suiteRunId, state: out.state, replayed: out.replayed };
    }

    /**
     * Which specs this run executes (6.1): the whole suite for a baseline; for a PR the plan of `planSuiteRun` over the change set,
     * the re-push rule when the PR has an earlier finished run, and the coverage map when there is one. A retry names its own specs.
     */
    private async plan(cmd: RuntimeSuiteRequested, s: Started, all: readonly string[], digest: string) {
        if (cmd.mode === 'baseline' || cmd.specs) return { specs: [...all], failedBefore: [] as string[], diffCoverage: {} as Record<string, number>, selection: { mode: 'full', reason: 'baseline', total: all.length } as SuiteSelectionReport };
        const map = await this.d.maps?.newest(cmd.organizationId, cmd.environmentId);
        const previous = await this.previousOf(cmd);
        return planSuiteRun({
            allSpecs: all,
            suiteDigest: digest,
            mergeBase: cmd.mergeBase!,
            prSha: cmd.prSha!,
            ...(cmd.changedFiles ? { changed: cmd.changedFiles } : {}),
            ...(cmd.deltaFiles ? { deltaFiles: cmd.deltaFiles } : {}),
            ...(previous ? { previous } : {}),
            ...(map ? { map } : {}),
            ignore: s.suite.ignore,
        });
    }

    /** The PR's earlier finished run, as the re-push rule reads it: what it ran and what was red after classification. */
    private async previousOf(cmd: RuntimeSuiteRequested): Promise<PreviousSuiteRun | undefined> {
        if (cmd.prNumber === undefined) return undefined;
        const prev = await this.d.runs.latestForPr(cmd.organizationId, cmd.environmentId, cmd.prNumber, new Date(cmd.requestedAt));
        if (!prev?.finishedAt || prev.suiteRunId === cmd.suiteRunId || !prev.prSha || !prev.mergeBase) return undefined;
        return {
            prSha: prev.prSha,
            mergeBase: prev.mergeBase,
            mode: prev.selection?.mode === 'selected' ? 'selected' : 'full',
            green: prev.state === 'passed',
            failures: (prev.classification?.tests ?? []).map((t) => ({ spec: t.spec, class: t.class })),
        };
    }

    /** A run that ended without running a spec: the row says how the specs were chosen. */
    private async endedWithoutRunning(cmd: RuntimeSuiteRequested, state: 'passed', selection: SuiteSelectionReport): Promise<SuiteServiceResult> {
        await this.d.runs.create({ ...this.runRecord(cmd), selection });
        await this.d.runs.finish(cmd.organizationId, cmd.suiteRunId, state, new Date(this.d.clock.now()));
        return { status: 'ran', suiteRunId: cmd.suiteRunId, state, replayed: false };
    }

    private runRecord(cmd: RuntimeSuiteRequested) {
        return {
            suiteRunId: cmd.suiteRunId,
            organizationId: cmd.organizationId,
            environmentId: cmd.environmentId,
            repositoryId: cmd.repositoryId,
            mode: cmd.mode,
            ...(cmd.prNumber !== undefined ? { prNumber: cmd.prNumber } : {}),
            ...(cmd.prSha ? { prSha: cmd.prSha } : {}),
            ...(cmd.mergeBase ? { mergeBase: cmd.mergeBase } : {}),
            mainSha: cmd.mainSha,
            requestedAt: new Date(cmd.requestedAt),
        };
    }

    /** The run row that says why nothing ran: neutral, never a failure of the PR. */
    private async unavailable(cmd: RuntimeSuiteRequested, reason: Extract<SuiteServiceResult, { status: 'unavailable' }>['reason']): Promise<SuiteServiceResult> {
        await this.d.runs.create(this.runRecord(cmd));
        await this.d.runs.finish(cmd.organizationId, cmd.suiteRunId, 'neutral', new Date(this.d.clock.now()));
        return { status: 'unavailable', suiteRunId: cmd.suiteRunId, state: 'neutral', reason };
    }
}
