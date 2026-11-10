import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { type BlockerEvidence, type BlockerFixView, classifyBlocker, KODY_FIX_PREFIX } from '@libs/runtime/blockers/catalog';
import { type Lesson, lessonsFor } from '@libs/runtime/blockers/lessons';
import { applyRecipeChange } from '@libs/runtime/blockers/recipe-edit';
import { isForkPullRequestPolicy, type ForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import { isMachineSizePreset, type MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import type { EnvironmentLearnRecord, EnvironmentRecipeRecord, EnvironmentSetupRecord, RuntimeRunProjection } from '@libs/runtime/run';

import { forkPolicyOf } from '../../domain/fork-policy';
import { MachineSizeAbovePlanError, parseMachineSizeSetting } from '../../domain/machine-size-plan';
import { effectivePoolSize, InvalidPoolPolicyError, InvalidPoolSizeError, parsePoolPolicy, parsePoolSetting, type PoolPolicy, type PoolReason } from '../../domain/pool';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_EGRESS_READER,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_ORG_REPOSITORIES,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    type Clock,
    type EgressBlockedRow,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RunProjectionReader,
    type RuntimeEgressReader,
    type RuntimeEnvironmentSetupReader,
    type RuntimeApiConfig,
    type RuntimeOrgRepositories,
    RUNTIME_LESSON_READER,
    type RuntimeLessonReader,
} from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimePoolController } from '../pool-controller.service';
import { RuntimeSetupRequester } from '../runtime-setup-requester.service';

export interface RuntimeEnvironmentView {
    environmentId: string;
    repositoryId: string;
    repositoryName?: string;
    state?: string;
    /** The org admin's diagnostic hold for failed default-branch setups (§11 runbook). */
    diagnosticHold?: boolean;
    /**
     * The org admin's machine size for builds and services (a preset of
     * contracts/machine-size.ts); null: the cell's default. It applies from
     * the next setup; `setup.machineSize` is what the last one booted at.
     */
    machineSize?: MachineSizePreset | null;
    /** What a PR from a fork does (contracts/enums.ts); set only for an environment of the product table. */
    forkPullRequests?: ForkPullRequestPolicy;
    /**
     * The warm pool: the size when ready (the admin's choice, null: the plan's default) and the plan's bounds,
     * when it is kept ready (policy), what the cell holds now and why, the month's estimated spend and the
     * most the policy may cost a month at list price.
     */
    pool?: {
        size: number;
        setting: number | null;
        defaultSize: number;
        maxSize: number;
        policy: PoolPolicy | null;
        now?: { size: number; reason: PoolReason };
        spentUsd?: number;
        estimate?: { hours: number | null; usd: number | null };
        usdPerMachineHour?: number;
        lastPullRequestAt?: string;
    };
    cellOwner?: 'kodus' | 'customer';
    metrics: {
        bootRate7d?: number;
        readyP50Ms?: number;
        readyP90Ms?: number;
        runs7d: number;
        egressBlocked: EgressBlockedRow[];
        /**
         * The environment's setup boots of the last 7 days (each from zero, so
         * slower than a Run's boot on the bake): how many, the share whose
         * machines became ready, and their time to ready. Kept apart from the
         * Run numbers above, which the warm pool and the targets read.
         */
        setupBoots?: { boots7d: number; bootRate7d: number; readyP50Ms?: number; readyP90Ms?: number };
    };
    egressApprovals: Array<{ host: string; approvedBy?: string; approvedAt?: string }>;
    /** The latest setup the runtime-worker recorded (progress and blockers). */
    setup?: Pick<EnvironmentSetupRecord, 'state' | 'steps' | 'blockers' | 'requestedAt' | 'updatedAt' | 'finishedAt' | 'sha' | 'branch' | 'refSource' | 'cellId' | 'expose' | 'failureBundle' | 'diagnosticHold' | 'progress' | 'lastActive' | 'machineSize' | 'bootTiming'> & {
        /** Which recipe the environment boots with; its text stays in the Runtime store. */
        recipe?: { path: string; sha: string; state: 'found' | 'absent'; digest?: string } & Pick<EnvironmentRecipeRecord, 'origin' | 'cleanBoots' | 'inference' | 'notes'> & {
                /** Only for a recipe Kodus inferred or Kody wrote: it is not repository text, and not on the default branch yet. */
                content?: string;
            };
        /** Kody's learn loop: what it tried and how each attempt ended, in Kodus's words (S-23). */
        learn?: RuntimeLearnView;
    };
    createdAt?: string;
    updatedAt?: string;
}

/** The learn loop as the product shows it: typed fixes and results; the proven recipe text only when Kodus wrote the recipe. */
export type RuntimeLearnView = Pick<EnvironmentLearnRecord, 'attempts' | 'stopped' | 'tried'> & {
    proven?: Omit<NonNullable<EnvironmentLearnRecord['proven']>, 'content' | 'change'> & { content?: string };
};

const learnView = (learn: EnvironmentLearnRecord): RuntimeLearnView => {
    const { proven } = learn;
    return {
        tried: learn.tried,
        attempts: learn.attempts.map((a) => ({
            n: a.n,
            signature: a.signature,
            ...(a.fix ? { fix: { id: a.fix.id, action: a.fix.action, label: a.fix.label } } : {}),
            result: a.result,
            ...(a.refusal ? { refusal: a.refusal } : {}),
            ...(a.cleanBoots !== undefined ? { cleanBoots: a.cleanBoots } : {}),
            ...(a.blocker ? { blocker: a.blocker } : {}),
            setupKey: a.setupKey,
            at: a.at,
        })),
        ...(learn.stopped ? { stopped: learn.stopped } : {}),
        ...(proven
            ? {
                  proven: {
                      signature: proven.signature,
                      fix: proven.fix,
                      digest: proven.digest,
                      cleanBoots: proven.cleanBoots,
                      origin: proven.origin,
                      // A repository recipe's text stays in the Runtime store; the fix shows as its diff on the card.
                      ...(proven.origin === 'inferred' ? { content: proven.content } : {}),
                  },
              }
            : {}),
    };
};

// The port lives in domain/ports; re-exported for the callers that imported it from here.
export { RUNTIME_ENVIRONMENT_SETUP_READER, type RuntimeEnvironmentSetupReader };

/** A fix as the product shows it: the catalog's, with the recipe diff when it changes the recipe. */
export type RuntimeBlockerFixView = Omit<BlockerFixView, 'recipeChange'> & {
    /** The one-field recipe change, as a unified diff of .kodus/workspace.yaml (ENV-05). */
    recipeDiff?: string;
    /** This fix got the same blocker past before (ADR-018): in this repo, or anywhere in the org. */
    learned?: { lessonId: string; scope: 'repo' | 'org'; helped: number; lastAt: string };
};

export interface RuntimeBlockerGroupView {
    signature: string;
    kind: string;
    title: string;
    count: number;
    lastAt?: string;
    lastPr?: number;
    state: 'open';
    evidence?: BlockerEvidence;
    /** In order; the first is the recommended one (ADR-015). */
    fixes: RuntimeBlockerFixView[];
}

const WEEK_MS = 7 * 24 * 3_600_000;

/**
 * The nearest-rank percentile (p in 0..100) of values, or undefined for none:
 * always one of the values, so a p90 of three boots is a boot that happened.
 */
export function percentile(values: readonly number[], p: number): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(rank, sorted.length) - 1];
}
/**
 * The setup boots since `since` (the record keeps at most a week, capped):
 * the share that became ready, and the time to ready of those that did.
 * Undefined when there was none.
 */
export function setupBootMetrics(boots: EnvironmentSetupRecord['boots'], since: Date): RuntimeEnvironmentView['metrics']['setupBoots'] {
    const week = (boots ?? []).filter((b) => Date.parse(b.at) >= since.getTime());
    if (!week.length) return undefined;
    const ready = week.filter((b) => b.outcome === 'ready').map((b) => b.ms);
    const readyP50Ms = percentile(ready, 50);
    const readyP90Ms = percentile(ready, 90);
    return {
        boots7d: week.length,
        bootRate7d: ready.length / week.length,
        ...(readyP50Ms !== undefined ? { readyP50Ms } : {}),
        ...(readyP90Ms !== undefined ? { readyP90Ms } : {}),
    };
}
/** Runs that reached the boot gate: they booted (testing or a verdict) or could not. */
const BOOT_ATTEMPTED: RuntimeRunProjection['state'][] = ['testing', 'no_regressions', 'regression', 'partly_tested', 'could_not_boot'];
const RUNS_SCAN = 200;
const ENVIRONMENT_RUNS_SCAN = 1_000;

const orgOf = (user: Partial<IUser>) => {
    const organizationId = user?.organization?.uuid;
    if (!organizationId) throw new NotFoundException('Organization not found');
    return organizationId;
};

const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

interface EnvironmentSource {
    environmentId: string;
    organizationId: string;
    repositoryId: string;
    repositoryName?: string;
    state?: string;
    setupRequestedAt?: string;
    diagnosticHold?: boolean;
    /** Set only for an environment of the product table: the admin's machine size (null: the cell's default). */
    machineSize?: MachineSizePreset | null;
    /** Set only for an environment of the product table: what a PR from a fork does. */
    forkPullRequests?: ForkPullRequestPolicy;
    /** Set only for an environment of the product table: the admin's pool size (null: the plan's default). */
    poolSize?: number | null;
    /** The product table's pool state (policy, activity, applied size, usage), for the pool view. */
    pool?: Pick<ProductEnvironment, 'poolSize' | 'poolPolicy' | 'poolActivityAt' | 'poolAppliedSize' | 'poolUsage'> & Pick<ProductEnvironment, 'environmentId' | 'organizationId'>;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Builds the environment views: product rows (`runtime_environments`) plus
 * the ones only the Run projection knows (Runs that predate the table).
 * Metrics come from the projection of the last 7 days; egress from the
 * Runtime Postgres, read-only.
 */
@Injectable()
export class EnvironmentViewBuilder {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_EGRESS_READER)
        private readonly egress: RuntimeEgressReader,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        @Optional()
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups?: RuntimeEnvironmentSetupReader,
        @Optional()
        @Inject(RUNTIME_API_CONFIG)
        private readonly config?: Pick<RuntimeApiConfig, 'pool'>,
        @Optional()
        private readonly poolController?: RuntimePoolController,
    ) {}

    private poolView(env: ProductEnvironment): NonNullable<RuntimeEnvironmentView['pool']> {
        const plan = this.config!.pool;
        const base = {
            size: effectivePoolSize(plan, env.poolSize),
            setting: env.poolSize ?? null,
            maxSize: plan.maxSize,
            defaultSize: Math.min(plan.defaultSize, plan.maxSize),
            policy: env.poolPolicy ?? null,
            ...(env.poolActivityAt ? { lastPullRequestAt: env.poolActivityAt } : {}),
        };
        if (!this.poolController) return base;
        const s = this.poolController.status(env);
        return { ...base, now: { size: s.size, reason: s.reason }, spentUsd: s.spentUsd, estimate: s.estimate, usdPerMachineHour: s.usdPerMachineHour };
    }

    async setup(organizationId: string, environmentId: string): Promise<EnvironmentSetupRecord | null> {
        const rec = (await this.setups?.get(organizationId, environmentId).catch(() => null)) ?? null;
        return rec && rec.organizationId === organizationId ? rec : null;
    }

    /** The org's latest Runs: enough to list environments that only Runs know. */
    async recentRuns(organizationId: string) {
        return this.runs.list({ organizationId, limit: RUNS_SCAN });
    }

    /** One environment's Runs of the metric window, read by environment (not cut from the org's latest). */
    async environmentRuns(organizationId: string, environmentId: string) {
        const since = new Date(this.now().getTime() - WEEK_MS).toISOString();
        return this.runs.list({ organizationId, environmentId, requestedSince: since, limit: ENVIRONMENT_RUNS_SCAN });
    }

    async sources(organizationId: string, runs: RuntimeRunProjection[]): Promise<EnvironmentSource[]> {
        const product = await this.environments.listByOrganization(organizationId);
        const byId = new Map<string, EnvironmentSource>(
            product.filter((e) => e.organizationId === organizationId).map((e) => [e.environmentId, fromProduct(e)]),
        );
        for (const r of runs) {
            if (r.organizationId !== organizationId || byId.has(r.environmentId)) continue;
            byId.set(r.environmentId, {
                environmentId: r.environmentId,
                organizationId,
                repositoryId: r.repositoryId,
                repositoryName: r.repositoryName,
                updatedAt: r.updatedAt,
            });
        }
        return [...byId.values()];
    }

    async source(organizationId: string, environmentId: string): Promise<{ env: EnvironmentSource; runs: RuntimeRunProjection[] } | null> {
        if (!validId(environmentId)) return null;
        let runs = (await this.environmentRuns(organizationId, environmentId)).filter((r) => r.organizationId === organizationId);
        const product = await this.environments.get(organizationId, environmentId);
        if (product && product.organizationId === organizationId) return { env: fromProduct(product), runs };
        // An environment only Runs know, with no Run in the window: its latest Run names it.
        if (!runs.length) runs = (await this.runs.list({ organizationId, environmentId, limit: 1 })).filter((r) => r.organizationId === organizationId);
        const latest = runs[0];
        if (!latest) return null;
        return {
            env: { environmentId, organizationId, repositoryId: latest.repositoryId, repositoryName: latest.repositoryName, updatedAt: latest.updatedAt },
            runs,
        };
    }

    async view(env: EnvironmentSource, runs: RuntimeRunProjection[], withEgress: boolean): Promise<RuntimeEnvironmentView> {
        const since = new Date(this.now().getTime() - WEEK_MS);
        const mine = runs.filter((r) => r.environmentId === env.environmentId);
        const week = mine.filter((r) => Date.parse(r.requestedAt) >= since.getTime());
        const attempted = week.filter((r) => BOOT_ATTEMPTED.includes(r.state));
        const booted = attempted.filter((r) => r.state !== 'could_not_boot');
        const readyTimes = week.map((r) => r.bootMs).filter((ms): ms is number => typeof ms === 'number' && ms >= 0);
        const readyP50Ms = percentile(readyTimes, 50);
        const readyP90Ms = percentile(readyTimes, 90);
        const [egressBlocked, egressApprovals] = withEgress
            ? await Promise.all([
                  this.egress.blockedForRuns(env.organizationId, week.map((r) => r.runId), since),
                  this.egress.approvals(env.organizationId, env.environmentId),
              ])
            : [[], []];
        const latest = mine[0];
        const ours = await this.setup(env.organizationId, env.environmentId);
        const setupBoots = setupBootMetrics(ours?.boots, since);
        // The worker's record wins once it answers the latest request (setup_requested → setting_up → active | blocked).
        const state = ours && (!env.setupRequestedAt || ours.requestedAt >= env.setupRequestedAt) ? ours.state : env.state;
        return {
            environmentId: env.environmentId,
            repositoryId: env.repositoryId,
            ...(env.repositoryName ? { repositoryName: env.repositoryName } : {}),
            ...(state ? { state } : {}),
            ...(env.diagnosticHold !== undefined ? { diagnosticHold: env.diagnosticHold } : {}),
            ...(env.machineSize !== undefined ? { machineSize: env.machineSize } : {}),
            ...(env.forkPullRequests !== undefined ? { forkPullRequests: env.forkPullRequests } : {}),
            // Only an environment of the product table has settings to change.
            ...(this.config && env.pool
                ? { pool: this.poolView(env.pool as ProductEnvironment) }
                : {}),
            ...(ours
                ? {
                      setup: {
                          state: ours.state,
                          steps: ours.steps,
                          blockers: ours.blockers,
                          requestedAt: ours.requestedAt,
                          updatedAt: ours.updatedAt,
                          ...(ours.finishedAt ? { finishedAt: ours.finishedAt } : {}),
                          ...(ours.sha ? { sha: ours.sha } : {}),
                          ...(ours.branch ? { branch: ours.branch } : {}),
                          ...(ours.refSource ? { refSource: ours.refSource } : {}),
                          ...(ours.recipe
                              ? {
                                    recipe: {
                                        path: ours.recipe.path,
                                        sha: ours.recipe.sha,
                                        state: ours.recipe.state,
                                        ...(ours.recipe.digest ? { digest: ours.recipe.digest } : {}),
                                        ...(ours.recipe.origin === 'inferred' || ours.recipe.origin === 'authored'
                                            ? {
                                                  origin: ours.recipe.origin,
                                                  cleanBoots: ours.recipe.cleanBoots ?? 0,
                                                  ...(ours.recipe.content ? { content: ours.recipe.content } : {}),
                                                  ...(ours.recipe.origin === 'authored' && ours.recipe.notes ? { notes: ours.recipe.notes } : {}),
                                              }
                                            : {}),
                                        ...(ours.recipe.inference ? { inference: ours.recipe.inference } : {}),
                                    },
                                }
                              : {}),
                          ...(ours.cellId ? { cellId: ours.cellId } : {}),
                          ...(ours.expose ? { expose: ours.expose } : {}),
                          ...(ours.failureBundle ? { failureBundle: ours.failureBundle } : {}),
                          ...(ours.diagnosticHold ? { diagnosticHold: ours.diagnosticHold } : {}),
                          ...(ours.progress ? { progress: ours.progress } : {}),
                          ...(ours.lastActive ? { lastActive: ours.lastActive } : {}),
                          ...(ours.machineSize ? { machineSize: ours.machineSize } : {}),
                          ...(ours.bootTiming ? { bootTiming: ours.bootTiming } : {}),
                          ...(ours.learn ? { learn: learnView(ours.learn) } : {}),
                      },
                  }
                : {}),
            ...(latest?.cellOwner ? { cellOwner: latest.cellOwner } : {}),
            metrics: {
                ...(attempted.length ? { bootRate7d: booted.length / attempted.length } : {}),
                ...(readyP50Ms !== undefined ? { readyP50Ms } : {}),
                ...(readyP90Ms !== undefined ? { readyP90Ms } : {}),
                runs7d: week.length,
                egressBlocked,
                ...(setupBoots ? { setupBoots } : {}),
            },
            egressApprovals,
            ...(env.createdAt ? { createdAt: env.createdAt } : {}),
            updatedAt: [env.updatedAt, latest?.updatedAt].filter(Boolean).sort().pop(),
        };
    }
}

const fromProduct = (e: ProductEnvironment): EnvironmentSource => ({
    environmentId: e.environmentId,
    organizationId: e.organizationId,
    repositoryId: e.repositoryId,
    repositoryName: e.repositoryName,
    state: e.state,
    setupRequestedAt: e.setupRequestedAt,
    diagnosticHold: e.diagnosticHold === true,
    machineSize: e.machineSize ?? null,
    forkPullRequests: forkPolicyOf(e.forkPullRequests),
    poolSize: e.poolSize ?? null,
    pool: {
        environmentId: e.environmentId,
        organizationId: e.organizationId,
        poolSize: e.poolSize ?? null,
        poolPolicy: e.poolPolicy ?? null,
        poolActivityAt: e.poolActivityAt ?? null,
        poolAppliedSize: e.poolAppliedSize ?? null,
        poolUsage: e.poolUsage ?? null,
    },
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
});

/** GET /runtime/environments — the org's environments the caller can read. */
@Injectable()
export class ListRuntimeEnvironmentsUseCase {
    constructor(
        private readonly reader: EnvironmentViewBuilder,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
    ) {}

    async execute(input: { user: Partial<IUser> }): Promise<RuntimeEnvironmentView[]> {
        const organizationId = orgOf(input.user);
        const scope = await this.authorization.getRepositoryScope({
            user: input.user,
            action: Action.Read,
            resource: ResourceType.RuntimeEnvironment,
        });
        if (scope !== null && scope.length === 0) return [];
        const recent = await this.reader.recentRuns(organizationId);
        const sources = (await this.reader.sources(organizationId, recent)).filter((e) => scope === null || scope.includes(e.repositoryId));
        // The list skips the Runtime Postgres (one query per environment); the detail has egress.
        // Metrics read each environment's own Runs of the window, not a cut of the org's latest.
        return Promise.all(sources.map(async (e) => this.reader.view(e, await this.reader.environmentRuns(organizationId, e.environmentId), false)));
    }
}

/** GET /runtime/environments/:id — another org's environment is 404. */
@Injectable()
export class GetRuntimeEnvironmentUseCase {
    constructor(
        private readonly reader: EnvironmentViewBuilder,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
    ) {}

    async load(user: Partial<IUser>, environmentId: string) {
        const organizationId = orgOf(user);
        const found = await this.reader.source(organizationId, environmentId);
        if (!found) throw new NotFoundException('Environment not found');
        await this.authorization.ensure({ user, action: Action.Read, resource: ResourceType.RuntimeEnvironment, repoIds: [found.env.repositoryId] });
        return found;
    }

    async setup(env: { environmentId: string; organizationId: string }) {
        return this.reader.setup(env.organizationId, env.environmentId);
    }

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeEnvironmentView> {
        const { env, runs } = await this.load(input.user, input.environmentId);
        return this.reader.view(env, runs, true);
    }
}

/** The recipe text the setup read, when the worker kept it (never shown as is; only the diff of a fix). */
// An inferred or authored recipe is not on the default branch yet: a one-field fix PR waits for the recipe PR.
const recipeText = (setup: EnvironmentSetupRecord | null) =>
    setup?.recipe?.state === 'found' && setup.recipe.origin !== 'inferred' && setup.recipe.origin !== 'authored' ? setup.recipe.content : undefined;

/** A catalog fix for the product: a recipe change becomes its diff, or plain guidance when it cannot be made by a PR. */
export function fixView(fix: BlockerFixView, recipe?: { text?: string; path?: string }): RuntimeBlockerFixView {
    const { recipeChange, ...rest } = fix;
    if (!recipeChange) return rest;
    if (!recipe?.text) {
        return { ...rest, who: 'dev', detail: `${rest.detail ?? ''} Kodus read no recipe for this environment, so the change is not offered as a PR.`.trim() };
    }
    const edit = applyRecipeChange(recipe.text, recipeChange, recipe.path);
    if ('error' in edit) return { ...rest, who: 'dev', detail: `${rest.detail ?? ''} Not offered as a PR: ${edit.error}.`.trim() };
    return { ...rest, recipeDiff: edit.diff };
}

/**
 * The environment's blockers grouped by signature, read by the catalog
 * (docs §4): the latest setup's blockers, with its failure bundle, and the
 * reasons of its could_not_boot Runs. Classified on every read, so a better
 * catalog applies to what was already recorded.
 */
export function blockerGroups(setup: EnvironmentSetupRecord | null, runs: RuntimeRunProjection[], memory?: { lessons: Lesson[]; organizationId: string; repositoryId: string }) {
    const groups = new Map<string, RuntimeBlockerGroupView & { recipeChanges: Map<string, BlockerFixView['recipeChange']> }>();
    const recipe = { text: recipeText(setup), path: setup?.recipe?.path };
    const add = (input: { kind: string; signature: string; message: string; bundle?: EnvironmentSetupRecord['failureBundle'] }, at?: string, pr?: number) => {
        const c = classifyBlocker(input);
        const g = groups.get(c.signature) ?? {
            signature: c.signature,
            kind: c.kind,
            title: c.title,
            count: 0,
            state: 'open' as const,
            evidence: c.evidence,
            fixes: c.fixes.map((f) => fixView(f, recipe)),
            recipeChanges: new Map(c.fixes.filter((f) => f.recipeChange).map((f) => [f.id, f.recipeChange])),
        };
        g.count += 1;
        if (!g.lastAt || (at && at > g.lastAt)) {
            g.lastAt = at;
            if (pr !== undefined) g.lastPr = pr;
        }
        groups.set(c.signature, g);
    };
    for (const b of setup?.blockers ?? []) add({ kind: b.kind, signature: b.signature, message: b.message, bundle: setup?.failureBundle }, b.at);
    // The fix Kody's learn loop proved (two clean boots) comes first on its card, as a one-field recipe PR (a repository recipe only:
    // an inferred one is proposed whole by the recipe PR).
    const proven = setup?.learn?.proven;
    const target = proven && proven.origin === 'repository' ? groups.get(proven.signature) : undefined;
    if (proven && target) {
        const fix: BlockerFixView = {
            id: `${KODY_FIX_PREFIX}${proven.fix.id}`,
            action: proven.fix.action,
            who: 'dev',
            label: `${proven.fix.label} (Kody's fix)`,
            detail: `Kody tried this change on ${proven.cleanBoots} clean machines and the app answered every time. Opens a PR on the recipe with the one-field change.`,
            recipeChange: proven.change,
        };
        target.fixes = [fixView(fix, recipe), ...target.fixes];
        target.recipeChanges.set(fix.id, proven.change);
    }
    for (const r of runs.filter((x) => x.state === 'could_not_boot')) {
        const reason = (r.reason ?? 'could_not_boot').slice(0, 500);
        add({ kind: 'unknown', signature: reason, message: reason }, r.finishedAt ?? r.updatedAt, r.prNumber);
    }
    // What worked before comes first (ADR-018); the catalog's order stays among the rest.
    if (memory?.lessons.length) {
        for (const g of groups.values()) {
            const known = lessonsFor(memory.lessons, { organizationId: memory.organizationId, repositoryId: memory.repositoryId, signature: g.signature });
            if (!known.length) continue;
            g.fixes = g.fixes.map((f) => {
                const l = known.filter((x) => x.fix.id === f.id).sort((a, b) => (a.scope === b.scope ? b.helped - a.helped : a.scope === 'repo' ? -1 : 1))[0];
                return l ? { ...f, learned: { lessonId: l.lessonId, scope: l.scope, helped: l.helped, lastAt: l.lastAt } } : f;
            });
            g.fixes = [...g.fixes.filter((f) => f.learned), ...g.fixes.filter((f) => !f.learned)];
        }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** The lessons that may apply to this environment's repo, or none when the store is unreachable (the cards still show). */
export async function memoryFor(reader: RuntimeLessonReader | undefined, env: { organizationId: string; repositoryId: string }) {
    const lessons = reader ? await reader.listByOrganization(env.organizationId).catch(() => []) : [];
    return { lessons, organizationId: env.organizationId, repositoryId: env.repositoryId };
}

/** GET /runtime/environments/:id/blockers — the groups, with their evidence and fixes, what worked before first. */
@Injectable()
export class ListEnvironmentBlockersUseCase {
    constructor(
        private readonly environment: GetRuntimeEnvironmentUseCase,
        @Optional() @Inject(RUNTIME_LESSON_READER) private readonly lessons?: RuntimeLessonReader,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<RuntimeBlockerGroupView[]> {
        const { env, runs } = await this.environment.load(input.user, input.environmentId);
        const setup = await this.environment.setup(env);
        return blockerGroups(setup, runs, await memoryFor(this.lessons, env)).map(({ recipeChanges: _, ...view }) => view);
    }
}

/**
 * Creates the product environment of a connected repo (idempotent) and asks
 * the Runtime to set it up, through the outbox. Used by POST
 * /runtime/environments and by a repo joining the pilot.
 */
@Injectable()
export class CreateRuntimeEnvironmentUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(RUNTIME_ORG_REPOSITORIES)
        private readonly repositories: RuntimeOrgRepositories,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        private readonly setups: RuntimeSetupRequester,
    ) {}

    async execute(input: { user: Partial<IUser>; repositoryId: unknown }): Promise<ProductEnvironment> {
        const organizationId = orgOf(input.user);
        if (!validId(input.repositoryId)) throw new BadRequestException('repositoryId is required');
        const { teamId, repositories } = await this.repositories.list(organizationId);
        const repo = repositories.find((r) => r.repositoryId === input.repositoryId);
        if (!repo || !teamId) throw new NotFoundException('Repository not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [repo.repositoryId],
        });
        const existing = await this.environments.findByRepository(organizationId, repo.repositoryId);
        if (existing) return existing;
        const env = await this.environments.create({ organizationId, teamId, repositoryId: repo.repositoryId, repositoryName: repo.repositoryName });
        return this.setups.request(env, input.user);
    }
}

/** POST /runtime/environments/:id/setup — (re)build the environment from its recipe on the default branch. */
@Injectable()
export class RequestEnvironmentSetupUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        private readonly setups: RuntimeSetupRequester,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string }): Promise<ProductEnvironment> {
        const organizationId = orgOf(input.user);
        const env = validId(input.environmentId) ? await this.environments.get(organizationId, input.environmentId) : null;
        if (!env || env.organizationId !== organizationId) throw new NotFoundException('Environment not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [env.repositoryId],
        });
        return this.setups.request(env, input.user);
    }
}

/**
 * PATCH /runtime/environments/:id/settings — the org admin's settings of one
 * environment: the diagnostic hold (§11 runbook; only ever a failed setup of
 * the default branch, never a PR), the machine size (a preset, or null for
 * the cell's default; it applies from the next setup), what a PR from a
 * fork does (ADR-030; skip, require_approval or run) and the warm pool size
 * (a whole number up to the plan's ceiling, or null for the plan's default).
 * A pool change goes to the Runtime through the outbox: the worker asks the
 * environment's cell.
 */
const SETTINGS_KEYS: readonly string[] = ['diagnosticHold', 'machineSize', 'forkPullRequests', 'poolSize', 'poolPolicy'];

@Injectable()
export class UpdateEnvironmentSettingsUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'pool' | 'machineSize'>,
        private readonly pool: RuntimePoolController,
    ) {}

    async execute(input: { user: Partial<IUser>; environmentId: string; body: unknown }): Promise<ProductEnvironment> {
        const organizationId = orgOf(input.user);
        const env = validId(input.environmentId) ? await this.environments.get(organizationId, input.environmentId) : null;
        if (!env || env.organizationId !== organizationId) throw new NotFoundException('Environment not found');
        const raw = input.body as Record<string, unknown> | null;
        // A field set to undefined was not sent (a validated DTO carries every declared field).
        const body = (raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) : null) as {
            diagnosticHold?: unknown;
            machineSize?: unknown;
            forkPullRequests?: unknown;
            poolSize?: unknown;
            poolPolicy?: unknown;
        } | null;
        const keys = body ? Object.keys(body) : [];
        if (
            !keys.length ||
            keys.some((k) => !SETTINGS_KEYS.includes(k)) ||
            ('diagnosticHold' in body! && typeof body!.diagnosticHold !== 'boolean') ||
            ('machineSize' in body! && body!.machineSize !== null && !isMachineSizePreset(body!.machineSize)) ||
            ('forkPullRequests' in body! && !isForkPullRequestPolicy(body!.forkPullRequests))
        ) {
            throw new BadRequestException(
                "Body must be { diagnosticHold?: boolean, machineSize?: 'small' | 'medium' | 'large' | null, forkPullRequests?: 'skip' | 'require_approval' | 'run', poolSize?: number | null, poolPolicy?: object | null }",
            );
        }
        let poolPolicy: PoolPolicy | null | undefined;
        if ('poolPolicy' in body!) {
            try {
                poolPolicy = parsePoolPolicy(body!.poolPolicy);
            } catch (e) {
                if (e instanceof InvalidPoolPolicyError) throw new BadRequestException(e.message);
                throw e;
            }
        }
        let machineSize: MachineSizePreset | null | undefined;
        if ('machineSize' in body!) {
            try {
                machineSize = parseMachineSizeSetting(this.config.machineSize, (body!.machineSize ?? null) as MachineSizePreset | null);
            } catch (e) {
                // A 400 like the pool's ceiling: the web shows the API's sentence (a 403 it replaces with its own).
                if (e instanceof MachineSizeAbovePlanError) throw new BadRequestException(e.message);
                throw e;
            }
        }
        let poolSize: number | null | undefined;
        if ('poolSize' in body!) {
            try {
                poolSize = parsePoolSetting(this.config.pool, body!.poolSize);
            } catch (e) {
                if (e instanceof InvalidPoolSizeError) throw new BadRequestException(e.message);
                throw e;
            }
        }
        await this.authorization.ensure({ user: input.user, action: Action.Manage, resource: ResourceType.RuntimeEnvironment, repoIds: [env.repositoryId] });
        const out: ProductEnvironment = { ...env };
        if (typeof body!.diagnosticHold === 'boolean') {
            await this.environments.setDiagnosticHold(organizationId, env.environmentId, body!.diagnosticHold);
            out.diagnosticHold = body!.diagnosticHold;
        }
        if (machineSize !== undefined) {
            await this.environments.setMachineSize(organizationId, env.environmentId, machineSize);
            out.machineSize = machineSize;
        }
        if (isForkPullRequestPolicy(body!.forkPullRequests)) {
            await this.environments.setForkPullRequests(organizationId, env.environmentId, body!.forkPullRequests);
            out.forkPullRequests = body!.forkPullRequests;
        }
        if (poolSize !== undefined) {
            await this.environments.setPoolSize(organizationId, env.environmentId, poolSize);
            out.poolSize = poolSize;
        }
        if (poolPolicy !== undefined) {
            await this.environments.setPoolPolicy(organizationId, env.environmentId, poolPolicy);
            out.poolPolicy = poolPolicy;
        }
        if (poolSize !== undefined || poolPolicy !== undefined) {
            // The size the policy wants now goes to the cell; the scheduler keeps it there.
            const requestedBy = { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) };
            const decision = await this.pool.apply(out, { force: true, requestedBy });
            out.poolAppliedSize = decision.size;
        }
        return out;
    }
}

/** @deprecated use EnvironmentViewBuilder. */
export const RuntimeEnvironmentsReader = EnvironmentViewBuilder;
/** @deprecated use EnvironmentViewBuilder. */
export type RuntimeEnvironmentsReader = EnvironmentViewBuilder;
