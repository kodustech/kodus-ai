import { type Claim } from '@libs/runtime/environment';
import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { parseRecipe } from '@libs/runtime/protocol/recipe';
import { sha256, uuidV5From } from '@libs/runtime/contracts/derive-id';
import { BRAKE_WINDOW_SHADOWS, brakeAfterMiss, type CoverageMapInput, diffReach, type DiffReach, MAP_MAX_COMMITS_BEHIND, missesOf, type PreviousSuiteRun, planSuiteRun, shadowDue, type SuiteSelectionReport, specListOf, suiteDigestOf } from '@libs/runtime/suite';

import type { PgSuiteBaselineRequests } from '../../shared/persistence/suite-baseline-requests';
import type { CoverageMapRecord } from './coverage-collector';
import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import type { Canary } from '../canary/canary';
import type { PgSuiteBaselines } from './pg-suite-baselines';
import type { StoredCoverageMap } from './pg-suite-coverage-maps';
import type { PgSuiteSelectionState, PgSuiteShadows } from './pg-suite-shadows';
import type { PgSuiteRuns, StoredSuiteRun, SuiteRunState } from './pg-suite-runs';
import type { PgSuiteSpecStats } from './pg-suite-spec-stats';
import type { EnvironmentSetupStore } from '../setup/environment-setup.store';
import { isCancellation } from '../workflow-cancellation';
import { mainHistoryOf } from './suite-adapters';
import { suiteConfigOf, type ResolvedSuite } from './suite-config';
import { execInService, type SuiteEnvironment } from './suite-environment';
import { type SuiteHostDemand, SuiteEngine, type SuiteTemplates } from './suite-engine';
import { TemplateSpecLister } from './spec-lister';
import { ExecArtifactSource, SuiteArtifactKeeper } from './suite-artifacts';
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

/** Raised when a shadow run found a regression the selection skipped (D14): a person should know selection may be unsafe here. Never carries a value of the repository, only paths. */
export interface SelectionAlert {
    type: 'selection_miss';
    organizationId: string;
    environmentId: string;
    shadowRunId: string;
    sourceRunId: string;
    /** The specs the selection skipped that the full run found a regression in. */
    specs: string[];
    changedFiles: string[];
    /** Two misses in the last ten shadows: selection is now off for the environment. */
    off: boolean;
}

export interface SuiteServiceDeps {
    setups: Pick<EnvironmentSetupStore, 'get'>;
    environment(ctx: SuiteEnvironmentContext): SuiteEnvironment;
    demand(scope: { organizationId: string; suiteRunId: string }): SuiteHostDemand;
    runs: Pick<PgSuiteRuns, 'create' | 'get' | 'finish' | 'savePlan' | 'recordResults' | 'recordArtifacts' | 'latestForPr'>;
    stats: Pick<PgSuiteSpecStats, 'read' | 'record'>;
    baselines?: Pick<PgSuiteBaselines, 'record' | 'findAmong'>;
    templates?: SuiteTemplates;
    /** Where the artifacts of failed specs are written (the evidence store); absent: none are kept. */
    evidence?: Pick<EvidenceStore, 'put'>;
    /**
     * The coverage maps of baselines (`PgSuiteCoverageMaps`): a baseline records one, a PR run reads the environment's newest complete
     * one. Absent: a baseline collects no coverage and every PR run is the whole suite with the reason `map_missing`.
     */
    maps?: { record(m: CoverageMapRecord): Promise<{ stored: boolean }>; newest(organizationId: string, environmentId: string): Promise<StoredCoverageMap | undefined> };
    headroom?(): Promise<number>;
    /** The baseline request a baseline run answers: marked started once the workflow holds it, so the product does not issue it again. */
    baselineRequests?: Pick<PgSuiteBaselineRequests, 'markStarted'>;
    /**
     * The shadow check of selection (6.1 Proof b, D14): every 5th, then 10th, selected run of an environment also enqueues a full
     * background run (`shadows`), and what that run finds the selection skipped turns the environment to the whole suite or off
     * (`selection`). Absent: no shadow, no brake.
     */
    shadows?: Pick<PgSuiteShadows, 'request' | 'get' | 'markStarted' | 'complete' | 'recentMisses'>;
    selection?: Pick<PgSuiteSelectionState, 'read' | 'recordSelected' | 'applyMiss' | 'consumeFullPr'>;
    alerts?(e: SelectionAlert): void;
    clock: { now(): number; sleep(ms: number): Promise<void> };
    /** The suite's check: opened when the run starts, closed with its conclusion. Absent: nothing is published. */
    publisher?: Pick<SuitePublisher, 'started' | 'finished' | 'cancelled'>;
}

export type SuiteServiceResult =
    /** The engine ran (or had run: `replayed`); `state` is the run's. */
    | { status: 'ran'; suiteRunId: string; state: SuiteRunState; replayed: boolean; /** A canary was found in an artifact (the Run that holds the suite halts). */ leaked?: boolean }
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

    async run(cmd: RuntimeSuiteRequested, step: SuiteStep, opts: { deadlineAt?: string; cancellationSignal?: () => AbortSignal | undefined; canaries?: readonly Canary[] } = {}): Promise<SuiteServiceResult> {
        const started = await step('suite:start', () => this.start(cmd));
        if ('status' in started) {
            if (cmd.mode === 'shadow') await step('suite:shadow-settle', () => this.settleShadow(cmd, started));
            return started;
        }
        // Publish steps retry (run-engine.service.ts `isPublishStep`): a broker that restarts never ends the suite without its check.
        // A shadow (the whole suite in the background, D14) never publishes: the PR's check is the selected run's alone.
        const publisher = cmd.mode === 'shadow' ? undefined : this.d.publisher;
        const suite = { ...(started.suite.config.cwd ? { cwd: started.suite.config.cwd } : {}) };
        let closed = false;
        try {
            if (publisher) await step('publish:suite-started', () => publisher.started(cmd));
            const result = await step('suite:run', async () => {
                const out = await this.runEngine(cmd, started, opts.deadlineAt ? Date.parse(opts.deadlineAt) : undefined, opts.cancellationSignal?.(), opts.canaries);
                // A cancelled workflow runs no step after this one, so its check is closed here, cancelled, never left in progress.
                if (publisher && out.status === 'ran' && out.state === 'cancelled') {
                    await publisher.finished(cmd, out, suite).catch(() => undefined);
                    closed = true;
                }
                return out;
            });
            if (publisher && !closed) await step('publish:suite-final', () => publisher.finished(cmd, result, suite));
            if (cmd.mode === 'shadow') await step('suite:shadow-settle', () => this.settleShadow(cmd, result));
            return result;
        } catch (e) {
            // The workflow was cancelled (a newer push, the PR closed, the Run stopped) before the engine could close the check.
            if (publisher && !closed && isCancellation(e)) await publisher.cancelled(cmd).catch(() => undefined);
            throw e;
        }
    }

    private async start(cmd: RuntimeSuiteRequested): Promise<Started | Extract<SuiteServiceResult, { status: 'off' }>> {
        // The baseline request is answered once a workflow holds it, whatever the recipe says: it is not asked for again.
        if (cmd.mode === 'baseline') await this.d.baselineRequests?.markStarted(cmd.organizationId, cmd.environmentId, cmd.mainSha).catch(() => undefined);
        if (cmd.mode === 'shadow') await this.d.shadows?.markStarted(cmd.organizationId, cmd.suiteRunId).catch(() => undefined);
        const setup = await this.d.setups.get(cmd.environmentId);
        const content = setup?.organizationId === cmd.organizationId && setup.recipe?.state === 'found' ? setup.recipe.content : undefined;
        const parsed = content ? parseRecipe(content) : undefined;
        const suite = parsed?.ok ? suiteConfigOf(parsed.recipe) : undefined;
        if (!suite || !setup) return { status: 'off', reason: 'no_suite' };
        if (cmd.mode === 'baseline' && !suite.baseline) return { status: 'off', reason: 'baseline_disabled' };
        return { suite, imageId: setup.imageId ?? 'latest', expose: setup.expose ?? [] };
    }

    private async runEngine(cmd: RuntimeSuiteRequested, s: Started, deadlineAt?: number, signal?: AbortSignal, canaries?: readonly Canary[]): Promise<SuiteServiceResult> {
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
        const plan = await this.plan(cmd, s, whole.map((x) => x.path), digest, !held);
        // A selected run is counted (and every 5th, then 10th, is shadowed) once: a step that runs again finds its run row and counts nothing.
        if (!held && !cmd.specs && cmd.mode !== 'baseline' && cmd.mode !== 'shadow' && (plan.selection.mode === 'selected' || plan.selection.mode === 'none')) await this.shadowIfDue(cmd, plan.specs);
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
            ...(this.d.maps ? { maps: this.d.maps } : {}),
            ...(this.d.evidence ? { artifacts: new SuiteArtifactKeeper({ source: new ExecArtifactSource(execInService(env, s.suite.config.service), `art-${cmd.suiteRunId}`), store: this.d.evidence }) } : {}),
            ...(this.d.templates ? { templates: this.d.templates } : {}),
            ...(this.d.headroom ? { headroom: this.d.headroom } : {}),
        });
        const out = await engine.run(cmd, {
            config: s.suite.config,
            specs,
            mainHistory: mainHistoryOf(cmd),
            ...(deadlineAt !== undefined && Number.isFinite(deadlineAt) ? { deadlineAt } : {}),
            ...(signal ? { signal } : {}),
            ...(canaries?.length ? { canaries } : {}),
            // A retry or a selection runs part of the suite; the digest that keys a baseline is the whole suite's.
            suiteDigest: digest,
            selection: this.withReach(cmd, cmd.specs ? { mode: 'selected', selected: specs.length, total: whole.length } : plan.selection, plan.reach),
            // What the diff reaches decides, while main is ahead, whether a failing spec is a regression; unset when no map could say.
            ...(plan.reach ? { diffReachedSpecs: plan.reach.specs } : {}),
            order: { failedBefore: plan.failedBefore, diffCoverage: plan.diffCoverage },
            // Only a baseline pays for coverage, and only where a map store keeps it.
            ...(cmd.mode === 'baseline' && this.d.maps ? { coverage: true } : {}),
        });
        return { status: 'ran', suiteRunId: cmd.suiteRunId, state: out.state, replayed: out.replayed, ...(out.leaked ? { leaked: true } : {}) };
    }

    /**
     * Which specs this run executes (6.1): the whole suite for a baseline; for a PR the plan of `planSuiteRun` over the change set,
     * the re-push rule when the PR has an earlier finished run, and the coverage map when there is one. A retry names its own specs.
     */
    private async plan(cmd: RuntimeSuiteRequested, s: Started, all: readonly string[], digest: string, first: boolean) {
        if (cmd.mode === 'shadow') return planSuiteRun({ allSpecs: all, suiteDigest: digest, mergeBase: cmd.mergeBase!, prSha: cmd.prSha!, forceFull: 'shadow' });
        if (cmd.mode === 'baseline') return { specs: [...all], failedBefore: [] as string[], diffCoverage: {} as Record<string, number>, selection: { mode: 'full', reason: 'baseline', total: all.length } as SuiteSelectionReport, reach: undefined as DiffReach | undefined };
        const stored = await this.d.maps?.newest(cmd.organizationId, cmd.environmentId);
        const map = stored ? this.mapInputOf(stored, cmd) : undefined;
        if (cmd.specs) {
            // A retry runs the specs it names, but is judged on the same diff as the run it retries.
            const reach = diffReach({ allSpecs: all, suiteDigest: digest, mergeBase: cmd.mergeBase!, prSha: cmd.prSha!, ...(cmd.changedFiles ? { changed: cmd.changedFiles } : {}), ...(map ? { map } : {}), ignore: s.suite.ignore, ...(s.suite.config.cwd ? { cwd: s.suite.config.cwd } : {}) });
            return { specs: [...all], failedBefore: [] as string[], diffCoverage: {} as Record<string, number>, selection: { mode: 'full', reason: 'baseline', total: all.length } as SuiteSelectionReport, reach: reach as DiffReach | undefined };
        }
        const prev = await this.previousRunOf(cmd);
        const previous = this.previousOf(cmd, prev);
        // The brake of the shadow check: off, or the whole suite after a miss; the whole suite is then the plan whatever the map says.
        const brake = await this.brakeOf(cmd, prev, first);
        return planSuiteRun({
            ...(brake ? { forceFull: brake } : {}),
            allSpecs: all,
            suiteDigest: digest,
            mergeBase: cmd.mergeBase!,
            prSha: cmd.prSha!,
            ...(cmd.changedFiles ? { changed: cmd.changedFiles } : {}),
            ...(cmd.deltaFiles ? { deltaFiles: cmd.deltaFiles } : {}),
            ...(previous ? { previous } : {}),
            ...(map ? { map } : {}),
            ignore: s.suite.ignore,
            ...(s.suite.config.cwd ? { cwd: s.suite.config.cwd } : {}),
        });
    }

    /** While main is ahead of the merge base, the check says why a failing spec cannot be confirmed when the diff's reach is unknown. */
    private withReach(cmd: RuntimeSuiteRequested, selection: SuiteSelectionReport, reach: DiffReach | undefined): SuiteSelectionReport {
        const ahead = !!cmd.mergeBase && cmd.mergeBase !== cmd.mainSha;
        return ahead && reach?.unknown ? { ...selection, reachUnknown: reach.unknown } : selection;
    }

    /**
     * The stored map as selection reads it (D12). How far behind main it is comes from the history the run is judged on: the map's
     * commit is main's head (the template's sha) or the merge base; any other commit cannot be placed, and an unplaced map is stale.
     */
    private mapInputOf(m: StoredCoverageMap, cmd: RuntimeSuiteRequested): CoverageMapInput {
        const at = mainHistoryOf(cmd).indexOf(m.mainSha);
        return { suiteDigest: m.suiteDigest, commitsBehindMain: at >= 0 ? at : MAP_MAX_COMMITS_BEHIND + 1, ageMs: Math.max(0, this.d.clock.now() - m.finishedAt.getTime()), specs: m.specs };
    }

    private async previousRunOf(cmd: RuntimeSuiteRequested) {
        return cmd.prNumber === undefined ? null : this.d.runs.latestForPr(cmd.organizationId, cmd.environmentId, cmd.prNumber, new Date(cmd.requestedAt));
    }

    /**
     * The shadow check's brake on this PR (D14): selection off, or the whole suite for the next `M` pull requests after a miss. Each
     * new pull request takes one of the `M` (a re-push of one that already ran under the brake stays on the whole suite and takes none).
     */
    private async brakeOf(cmd: RuntimeSuiteRequested, prev: StoredSuiteRun | null, first: boolean): Promise<'selection_off' | 'selection_miss' | undefined> {
        if (!this.d.selection) return undefined;
        const state = await this.d.selection.read(cmd.organizationId, cmd.environmentId);
        if (state.off) return 'selection_off';
        const underBrake = prev?.selection?.mode === 'full' && prev.selection.reason === 'selection_miss';
        if (underBrake) return 'selection_miss';
        if (state.fullPrsLeft <= 0) return undefined;
        if (first) await this.d.selection.consumeFullPr(cmd.organizationId, cmd.environmentId);
        return 'selection_miss';
    }

    /** Counts this selected run and, on the 5th (then every 10th), asks for its shadow: the product issues the full run, since only it can mint the download tokens. */
    private async shadowIfDue(cmd: RuntimeSuiteRequested, selected: readonly string[]): Promise<void> {
        const { selection, shadows } = this.d;
        if (!selection || !shadows) return;
        const count = await selection.recordSelected(cmd.organizationId, cmd.environmentId);
        if (!shadowDue(count)) return;
        await shadows.request({
            shadowRunId: uuidV5From(sha256(`suite-shadow:${cmd.organizationId}:${cmd.suiteRunId}`)),
            organizationId: cmd.organizationId,
            environmentId: cmd.environmentId,
            repositoryId: cmd.repositoryId,
            sourceRunId: cmd.suiteRunId,
            prNumber: cmd.prNumber!,
            prSha: cmd.prSha!,
            mergeBase: cmd.mergeBase!,
            mainSha: cmd.mainSha,
            selected: [...selected],
            changedFiles: [...(cmd.changedFiles ?? [])],
            removedFiles: [...(cmd.removedFiles ?? [])],
        });
    }

    /**
     * What a finished shadow says (6.1 Proof b): the regressions the full run found in specs the selection skipped are its misses. A miss
     * puts the environment on the whole suite for the next 10 pull requests and raises an alert; two misses in the last ten shadows turn
     * selection off. A shadow that did not finish (no host, a timeout, a cancel) is no evidence and counts for nothing. Applied once:
     * a shadow already completed changes nothing.
     */
    private async settleShadow(cmd: RuntimeSuiteRequested, result: Pick<SuiteServiceResult, 'status'>): Promise<void> {
        const { shadows, selection } = this.d;
        if (!shadows) return;
        const shadow = await shadows.get(cmd.organizationId, cmd.suiteRunId);
        if (!shadow || shadow.state === 'done') return;
        const run = result.status === 'ran' ? await this.d.runs.get(cmd.organizationId, cmd.suiteRunId) : null;
        const classification = run?.classification;
        const conclusive = !!classification && !!run && ['passed', 'failed', 'neutral'].includes(run.state);
        const misses = conclusive ? missesOf({ selected: shadow.selected, classification }) : [];
        if (misses.length > 0 && selection) {
            const state = await selection.read(cmd.organizationId, cmd.environmentId);
            const recent = (await shadows.recentMisses(cmd.organizationId, cmd.environmentId, BRAKE_WINDOW_SHADOWS, state.reenabledAt)) + misses.length;
            const brake = brakeAfterMiss({ missesInWindow: recent });
            await selection.applyMiss(cmd.organizationId, cmd.environmentId, brake);
            this.d.alerts?.({ type: 'selection_miss', organizationId: cmd.organizationId, environmentId: cmd.environmentId, shadowRunId: shadow.shadowRunId, sourceRunId: shadow.sourceRunId, specs: misses, changedFiles: shadow.changedFiles, off: brake.off });
        }
        await shadows.complete(cmd.organizationId, cmd.suiteRunId, { misses, conclusive }, new Date(this.d.clock.now()));
    }

    /** The PR's earlier finished run, as the re-push rule reads it: what it ran and what was red after classification. */
    private previousOf(cmd: RuntimeSuiteRequested, prev: StoredSuiteRun | null): PreviousSuiteRun | undefined {
        if (cmd.prNumber === undefined) return undefined;
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
