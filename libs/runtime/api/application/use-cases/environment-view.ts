import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { type BlockerEvidence, type BlockerFixView } from '@libs/runtime/blockers/catalog';
import { type ForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import { type MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import type { EnvironmentLearnRecord, EnvironmentRecipeRecord, EnvironmentSetupRecord, RuntimeRunProjection } from '@libs/runtime/run';

import { forkPolicyOf } from '../../domain/fork-policy';
import { effectivePoolSize, type PoolPolicy, type PoolReason } from '../../domain/pool';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_EGRESS_READER,
    RUNTIME_ENVIRONMENT_SETUP_READER,
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
} from '../../domain/ports';
import { RuntimePoolController } from '../pool-controller.service';

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

/** @deprecated use EnvironmentViewBuilder. */
export const RuntimeEnvironmentsReader = EnvironmentViewBuilder;
/** @deprecated use EnvironmentViewBuilder. */
export type RuntimeEnvironmentsReader = EnvironmentViewBuilder;
