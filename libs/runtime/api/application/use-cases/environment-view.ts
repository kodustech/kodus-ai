import { recipeOutsideRepository } from '@libs/runtime/contracts/runtime-commands';
import { stuckSetups } from '@libs/runtime/health/stuck';
import { Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import type { ForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import type { MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import type { PreviewSecrets } from '@libs/runtime/contracts/preview';
import type { EnvironmentLearnRecord, EnvironmentSetupRecord, RuntimeRunProjection } from '@libs/runtime/run';
import type {
    RuntimeBlockerFixView,
    RuntimeBlockerGroupView,
    RuntimeEnvironmentRepositoryView,
    RuntimeEnvironmentState,
    RuntimeEnvironmentView,
    RuntimeLearnView,
    RuntimeMembershipBlockerGroupView,
    RuntimeMembershipFixView,
} from '@libs/runtime/contracts/views/environments';

import { effectiveForkPolicy, forkPolicyOf } from '../../domain/fork-policy';
import { effectivePoolSize } from '../../domain/pool';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_BUILD_STATE_EVICTION_READER,
    RUNTIME_CLOCK,
    RUNTIME_EGRESS_READER,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    type Clock,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    listRunSummaries,
    type RunSummaryReader,
    type RuntimeBuildStateEvictionReader,
    type RuntimeEgressReader,
    type RuntimeEnvironmentSetupReader,
    type RuntimeApiConfig,
} from '../../domain/ports';
import { environmentRepositoryIds, RuntimeEnvironmentMembers } from '../environment-members.service';
import { RuntimePoolController } from '../pool-controller.service';

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

// The views live in contracts/views/environments.ts (the web imports them too); re-exported for the callers that imported them from here.
export type {
    RuntimeBlockerFixView,
    RuntimeBlockerGroupView,
    RuntimeEnvironmentRepositoryView,
    RuntimeEnvironmentView,
    RuntimeLearnView,
    RuntimeMembershipBlockerGroupView,
    RuntimeMembershipFixView,
};

// The port lives in domain/ports; re-exported for the callers that imported it from here.
export { RUNTIME_ENVIRONMENT_SETUP_READER, type RuntimeEnvironmentSetupReader };

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
/** The fields of a Run's report the environment metrics read (view()). */
const METRIC_REPORT_FIELDS = ['bootMs', 'cellOwner'] as const;
const ENVIRONMENT_RUNS_SCAN = 1_000;

export const orgOf = (user: Partial<IUser>) => {
    const organizationId = user?.organization?.uuid;
    if (!organizationId) throw new NotFoundException('Organization not found');
    return organizationId;
};

export const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

interface EnvironmentSource {
    environmentId: string;
    organizationId: string;
    repositoryId: string;
    repositoryName?: string;
    /** It has a row in the product table; absent or false: only Runs know it. */
    managed?: boolean;
    state?: RuntimeEnvironmentState;
    setupRequestedAt?: string;
    diagnosticHold?: boolean;
    /** Set only for an environment of the product table: the admin's machine size (null: the cell's default). */
    machineSize?: MachineSizePreset | null;
    /** Set only for an environment of the product table: what a PR from a fork does. */
    forkPullRequests?: ForkPullRequestPolicy;
    /** Set only for an environment of the product table: the admin's pool size (null: the plan's default). */
    poolSize?: number | null;
    /** Set only for an environment of the product table: the org's secrets in its previews. */
    previewSecrets?: PreviewSecrets;
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
        private readonly runs: RunSummaryReader,
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
        // Required by Nest; a builder made without it (the older tests) lists no repositories.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
        @Optional()
        @Inject(RUNTIME_BUILD_STATE_EVICTION_READER)
        private readonly evictions?: RuntimeBuildStateEvictionReader,
    ) {}

    /**
     * The eviction of the build state the environment's last setup left: on
     * the cell that setup built on, after it finished. A read that fails says
     * nothing (the screen loses a hint, never the environment).
     */
    private async buildCacheOf(env: EnvironmentSource, setup: EnvironmentSetupRecord | null): Promise<RuntimeEnvironmentView['buildCache']> {
        if (!this.evictions || !setup || setup.state !== 'active') return undefined;
        const cell = setup.buildCellId ?? setup.cellId;
        const since = Date.parse(setup.finishedAt ?? setup.updatedAt);
        const rows = await this.evictions.evictions(env.organizationId, env.environmentId).catch(() => []);
        const hit = rows.find((r) => (!cell || r.cellId === cell) && !(Date.parse(r.evictedAt) < since));
        return hit ? { state: 'evicted', evictedAt: hit.evictedAt, cellId: hit.cellId, reason: 'disk_floor', ...(hit.floorBytes ? { freeBytes: hit.freeBytes ?? 0, floorBytes: hit.floorBytes } : {}) } : undefined;
    }

    /**
     * Every repository of the environment: reading or acting on it needs
     * access to all of them, since its machines hold all their code.
     */
    repositoryIdsOf(env: Pick<EnvironmentSource, 'organizationId' | 'environmentId' | 'repositoryId'>): Promise<string[]> {
        return environmentRepositoryIds(this.members, env);
    }

    /** repositoryIdsOf() of several environments, in one read of the membership table: by environment id. */
    async repositoryIdsOfMany(envs: ReadonlyArray<Pick<EnvironmentSource, 'organizationId' | 'environmentId' | 'repositoryId'>>): Promise<Map<string, string[]>> {
        if (!this.members) return new Map(envs.map((e) => [e.environmentId, [e.repositoryId]]));
        const out = new Map<string, string[]>();
        for (const organizationId of new Set(envs.map((e) => e.organizationId))) {
            const mine = envs.filter((e) => e.organizationId === organizationId);
            const ids = await this.members.repositoryIdsOfEnvironments(organizationId, new Map(mine.map((e) => [e.environmentId, [e.repositoryId]])));
            for (const [k, v] of ids) out.set(k, v);
        }
        return out;
    }

    private async repositoriesOf(env: EnvironmentSource, setup: EnvironmentSetupRecord | null): Promise<RuntimeEnvironmentRepositoryView[] | undefined> {
        // Only an environment of the product table has repositories to list; one only Runs know is its Run's.
        if (!this.members || !env.pool || !env.repositoryName) return undefined;
        const rows = await this.members.list({ ...env, repositoryName: env.repositoryName });
        return rows.map((r) => ({
            repositoryId: r.repositoryId,
            repositoryName: r.repositoryName,
            fullName: r.fullName,
            alias: r.alias,
            role: r.role,
            triggers: r.triggers,
            pairBranches: r.pairBranches,
            ...(lastSetupShaOf(r, setup) ? { lastSetupSha: lastSetupShaOf(r, setup) } : {}),
        }));
    }

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
        // A store that cannot be read is not an environment without a setup: the view and its blockers fail as unavailable.
        const rec =
            (await this.setups?.get(organizationId, environmentId).catch(() => {
                throw new ServiceUnavailableException('The environment setup could not be read. Try again.');
            })) ?? null;
        return rec && rec.organizationId === organizationId ? rec : null;
    }

    /** The org's latest Runs: enough to list environments that only Runs know (their columns only). */
    async recentRuns(organizationId: string) {
        return listRunSummaries(this.runs, { organizationId, limit: RUNS_SCAN }, METRIC_REPORT_FIELDS);
    }

    /**
     * environmentRuns() with only the report fields the list's metrics read:
     * the list never moves a whole report per Run (WP1/WP10).
     */
    async environmentMetricRuns(organizationId: string, environmentId: string) {
        const since = new Date(this.now().getTime() - WEEK_MS).toISOString();
        return listRunSummaries(this.runs, { organizationId, environmentId, requestedSince: since, limit: ENVIRONMENT_RUNS_SCAN }, METRIC_REPORT_FIELDS);
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
                managed: false,
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
            env: { environmentId, organizationId, repositoryId: latest.repositoryId, repositoryName: latest.repositoryName, managed: false, updatedAt: latest.updatedAt },
            runs,
        };
    }

    /**
     * Where each of the org's environments and its setup are, without
     * metrics, Runs or the setup record: three reads whatever the number of
     * environments (the product table, the membership table for a scoped
     * viewer, the setups' typed columns). What the screens poll while a
     * setup runs; they read the whole view again only when this changes.
     */
    async statuses(organizationId: string, scope: string[] | null): Promise<RuntimeEnvironmentStatusView[]> {
        const product = (await this.environments.listByOrganization(organizationId)).filter((e) => e.organizationId === organizationId);
        const held = scope === null ? null : await this.repositoryIdsOfMany(product);
        const visible = held === null ? product : product.filter((e) => (held.get(e.environmentId) ?? [e.repositoryId]).every((id) => scope!.includes(id)));
        if (!visible.length) return [];
        const ids = visible.map((e) => e.environmentId);
        const rows = await (this.setups?.statuses
            ? this.setups.statuses(organizationId, ids)
            : Promise.all(ids.map((id) => this.setups?.get(organizationId, id) ?? null)).then((list) =>
                  list.filter((r): r is EnvironmentSetupRecord => !!r).map((r) => ({ environmentId: r.environmentId, state: r.state, requestedAt: r.requestedAt, updatedAt: r.updatedAt, ...(r.progress?.updatedAt ? { progressAt: r.progress.updatedAt } : {}) })),
              )
        ).catch(() => {
            throw new ServiceUnavailableException('The environment setups could not be read. Try again.');
        });
        const setupOf = new Map(rows.map((r) => [r.environmentId, r]));
        return visible.map((e) => {
            const ours = setupOf.get(e.environmentId) ?? null;
            const state = effectiveState(fromProduct(e), ours);
            return {
                environmentId: e.environmentId,
                ...(state ? { state } : {}),
                ...(ours
                    ? { setup: { state: ours.state, requestedAt: ours.requestedAt, updatedAt: ours.updatedAt, ...(ours.progressAt ? { progress: { updatedAt: ours.progressAt } } : {}) } }
                    : {}),
                updatedAt: e.updatedAt,
            };
        });
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
        const repositories = await this.repositoriesOf(env, ours);
        const setupBoots = setupBootMetrics(ours?.boots, since);
        const buildCache = await this.buildCacheOf(env, ours);
        const state = effectiveState(env, ours);
        return {
            environmentId: env.environmentId,
            repositoryId: env.repositoryId,
            ...(env.repositoryName ? { repositoryName: env.repositoryName } : {}),
            managed: env.managed === true,
            ...(repositories ? { repositories } : {}),
            ...(state ? { state } : {}),
            ...(env.diagnosticHold !== undefined ? { diagnosticHold: env.diagnosticHold } : {}),
            ...(env.machineSize !== undefined ? { machineSize: env.machineSize } : {}),
            ...(env.forkPullRequests !== undefined
                ? { forkPullRequests: env.forkPullRequests, effectiveForkPullRequests: effectiveForkPolicy(env.forkPullRequests, repositories?.length ?? 1) }
                : {}),
            ...(env.previewSecrets !== undefined ? { previewSecrets: env.previewSecrets } : {}),
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
                          // Past the longest a setup may last, or without a saved step for longer than one boot (libs/runtime/health/stuck.ts).
                          ...stuckSetupView(ours, this.now()),
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
                                        ...(ours.recipe.origin && recipeOutsideRepository(ours.recipe.origin)
                                            ? {
                                                  origin: ours.recipe.origin,
                                                  cleanBoots: ours.recipe.cleanBoots ?? 0,
                                                  ...(ours.recipe.content ? { content: ours.recipe.content } : {}),
                                                  // The build files under .kodus/ that boot with it (Kody's, or the developer's agent's): what the screen shows beside the recipe.
                                                  ...(ours.recipe.files?.length ? { files: ours.recipe.files.map((f) => ({ path: f.path, content: f.content })) } : {}),
                                                  ...(ours.recipe.origin === 'authored' && ours.recipe.notes ? { notes: ours.recipe.notes } : {}),
                                                  ...(ours.recipe.origin === 'authored' && ours.recipe.authorVersion ? { authorVersion: ours.recipe.authorVersion } : {}),
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
                          // Kody's last rewrite of the recipe for a new version of its instructions: versions, the reason, the outcome.
                          ...(ours.reauthor ? { reauthor: ours.reauthor } : {}),
                          // Kody's rewrites of its own recipe in this setup: digests, outcomes and the catalog's blocker titles, never recipe text.
                          ...(ours.repairs?.length
                              ? {
                                    repairs: ours.repairs.map((r) => ({
                                        n: r.n,
                                        max: r.max,
                                        blocker: { kind: r.blocker.kind, signature: r.blocker.signature, title: r.blocker.title },
                                        failedDigest: r.failedDigest,
                                        ...(r.recipeDigest ? { recipeDigest: r.recipeDigest } : {}),
                                        outcome: r.outcome,
                                        at: r.at,
                                    })),
                                }
                              : {}),
                      },
                  }
                : {}),
            ...(latest?.cellOwner ? { cellOwner: latest.cellOwner } : {}),
            ...(buildCache ? { buildCache } : {}),
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

/** The worker's record wins once it answers the latest request (setup_requested → setting_up → active | blocked). */
const effectiveState = (
    env: Pick<EnvironmentSource, 'setupRequestedAt' | 'state'>,
    ours: Pick<EnvironmentSetupRecord, 'requestedAt' | 'state'> | null,
): RuntimeEnvironmentState | undefined => (ours && (!env.setupRequestedAt || ours.requestedAt >= env.setupRequestedAt) ? ours.state : env.state);

/**
 * GET /runtime/environments/status: an environment of the product table, its
 * state as the list shows it, and its setup's times. The web compares it with
 * the list it holds and reads the list again only when one differs.
 */
export interface RuntimeEnvironmentStatusView {
    environmentId: string;
    state?: RuntimeEnvironmentState;
    setup?: Pick<EnvironmentSetupRecord, 'state' | 'requestedAt' | 'updatedAt'> & { progress?: { updatedAt: string } };
    updatedAt?: string;
}

/** The commit the setup booted a repository at: the setup's own for the primary, its workspace entry for a member. */
const lastSetupShaOf = (r: Pick<RuntimeEnvironmentRepositoryView, 'repositoryId' | 'role'>, setup: EnvironmentSetupRecord | null): string | undefined =>
    r.role === 'primary' ? setup?.sha : setup?.workspace?.find((w) => w.repositoryId === r.repositoryId)?.sha;

const fromProduct = (e: ProductEnvironment): EnvironmentSource => ({
    environmentId: e.environmentId,
    organizationId: e.organizationId,
    repositoryId: e.repositoryId,
    repositoryName: e.repositoryName,
    managed: true,
    state: e.state,
    setupRequestedAt: e.setupRequestedAt,
    diagnosticHold: e.diagnosticHold === true,
    machineSize: e.machineSize ?? null,
    forkPullRequests: forkPolicyOf(e.forkPullRequests),
    previewSecrets: e.previewSecrets === 'run' ? 'run' : 'none',
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

/** @deprecated use EnvironmentViewBuilder. */
export const RuntimeEnvironmentsReader = EnvironmentViewBuilder;
/** @deprecated use EnvironmentViewBuilder. */
export type RuntimeEnvironmentsReader = EnvironmentViewBuilder;

/** The hang detector's verdict on this setup, for Environment Health: absent while it is within its bound. */
function stuckSetupView(setup: EnvironmentSetupRecord, now: Date): { stuck?: { state: string; since: string; ageMs: number; boundMs: number } } {
    const [item] = stuckSetups([{ environmentId: setup.environmentId, organizationId: setup.organizationId, setupKey: setup.key, state: setup.state, requestedAt: setup.requestedAt, updatedAt: setup.updatedAt }], now);
    return item ? { stuck: { state: item.state, since: item.since, ageMs: item.ageMs, boundMs: item.boundMs } } : {};
}
