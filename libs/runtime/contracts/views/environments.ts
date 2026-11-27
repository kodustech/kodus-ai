import type { EgressApprovalRow, EgressBlockedRow, ProductEnvironment } from '@libs/runtime/api/domain/ports';
import type { PoolPolicy, PoolReason } from '@libs/runtime/api/domain/pool';
import type { BlockerEvidence, BlockerFixView } from '@libs/runtime/blockers/catalog';
import type { EnvironmentRepositoryRole, ForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import type { MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import type { PreviewSecrets } from '@libs/runtime/contracts/preview';
import type { EnvironmentLearnRecord, EnvironmentRecipeRecord, EnvironmentSetupRecord } from '@libs/runtime/run/environment-setup';

// What GET /runtime/environments, /environments/:id and its blockers answer:
// types only, so the use cases (api/application/use-cases/environment-view.ts)
// and the web (apps/web/src/lib/services/runtime/contracts.ts) import the same
// shape. Every import here is `import type`; nothing of it reaches a bundle.

/** One repository of an environment, as its Repositories section shows it (apps/web EnvironmentRepository). */
export interface RuntimeEnvironmentRepositoryView {
    repositoryId: string;
    repositoryName: string;
    fullName: string;
    /** Its directory beside the others in the workspace (ws/<alias>). */
    alias: string;
    role: EnvironmentRepositoryRole;
    /** A pull request of this repository starts a Run of this environment. */
    triggers: boolean;
    /** A Run boots this repository's open PR of the same branch name instead of its default branch. */
    pairBranches: boolean;
    /** The commit the last setup built it at; absent before one, and for a member that setup did not boot. */
    lastSetupSha?: string;
}

/**
 * The environment's state as the API merges it: the worker's setup record
 * once it answered the latest request, else the product row
 * (`setup_requested`, or `active` for a row never set up).
 */
export type RuntimeEnvironmentState = EnvironmentSetupRecord['state'] | ProductEnvironment['state'];

export interface RuntimeEnvironmentView {
    environmentId: string;
    /** The primary repository: the one that holds the recipe and names the environment. */
    repositoryId: string;
    repositoryName?: string;
    /**
     * The environment has a row in the product table: it can be set up and
     * configured. False for one only earlier Runs know (an id that predates
     * the table), which no setup, settings or repositories route accepts.
     */
    managed: boolean;
    /** Every repository of the environment, the primary first (an environment of the product table only). */
    repositories?: RuntimeEnvironmentRepositoryView[];
    state?: RuntimeEnvironmentState;
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
     * The policy that applies: `forkPullRequests`, except that `run` reads as
     * `require_approval` in an environment of several repositories (a fork's
     * code would run next to every member's). Set with `forkPullRequests`.
     */
    effectiveForkPullRequests?: ForkPullRequestPolicy;
    /** The org's secrets in this environment's previews (none, or the same as its Runs); set only for an environment of the product table. */
    previewSecrets?: PreviewSecrets;
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
    /**
     * The build cache of this environment was removed from its cell to free
     * disk after its last setup (the cell's evictedBuildStates): its pull
     * requests build with no cache, slower and maybe past their boot's wait,
     * until a setup again restores it. Absent: the cache is in place or unknown.
     * `freeBytes` and `floorBytes`: what the cell's volume had free and the
     * free space it keeps (why the cache was not kept), when the cell said so.
     */
    buildCache?: { state: 'evicted'; evictedAt: string; cellId: string; reason: 'disk_floor'; freeBytes?: number; floorBytes?: number };
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
    egressApprovals: EgressApprovalRow[];
    /** The latest setup the runtime-worker recorded (progress and blockers). */
    setup?: Pick<EnvironmentSetupRecord, 'state' | 'steps' | 'blockers' | 'requestedAt' | 'updatedAt' | 'finishedAt' | 'sha' | 'branch' | 'refSource' | 'cellId' | 'expose' | 'failureBundle' | 'diagnosticHold' | 'progress' | 'lastActive' | 'machineSize' | 'bootTiming' | 'repairs' | 'reauthor'> & {
        /** Which recipe the environment boots with; its text stays in the Runtime store. */
        recipe?: { path: string; sha: string; state: 'found' | 'absent'; digest?: string } & Pick<EnvironmentRecipeRecord, 'origin' | 'cleanBoots' | 'inference' | 'notes' | 'authorVersion'> & {
                /** Only for a recipe Kodus inferred or Kody wrote: it is not repository text, and not on the default branch yet. */
                content?: string;
                /** The build files under .kodus/ that boot with such a recipe (Kody's, or the developer's agent's). */
                files?: Array<{ path: string; content: string }>;
            };
        /** Kody's learn loop: what it tried and how each attempt ended, in Kodus's words (S-23). */
        learn?: RuntimeLearnView;
        /** Past the hang detector's bound (libs/runtime/health/stuck.ts): reported, nothing was stopped. */
        stuck?: { state: string; since: string; ageMs: number; boundMs: number };
    };
    createdAt?: string;
    updatedAt?: string;
}

/** The learn loop as the product shows it: typed fixes and results; the proven recipe text only when Kodus wrote the recipe. */
export type RuntimeLearnView = Pick<EnvironmentLearnRecord, 'attempts' | 'stopped' | 'tried'> & {
    proven?: Omit<NonNullable<EnvironmentLearnRecord['proven']>, 'content' | 'change'> & { content?: string };
};

/** A fix as the product shows it: the catalog's, with the recipe diff when it changes the recipe. */
export type RuntimeBlockerFixView = Omit<BlockerFixView, 'recipeChange'> & {
    /** The one-field recipe change, as a unified diff of .kodus/workspace.yaml (ENV-05). */
    recipeDiff?: string;
    /** This fix got the same blocker past before (ADR-018): in this repo, or anywhere in the org. */
    learned?: { lessonId: string; scope: 'repo' | 'org'; helped: number; lastAt: string };
};

/**
 * A fix about the environment's repositories, for what the committed
 * recipe's services.needs asks: `add_repository` (POST
 * /runtime/environments/:id/repositories with `repositoryId` and `alias`), or
 * `connect_repository` (the repository is not connected to Kodus yet).
 */
export type RuntimeMembershipFixView = Omit<RuntimeBlockerFixView, 'action' | 'recipeDiff' | 'learned'> & {
    action: 'add_repository' | 'connect_repository';
    /** For add_repository: the connected repository to add. */
    repositoryId?: string;
    /** The repository as the recipe names it (owner/name). */
    repository: string;
    /** For add_repository: the directory services.needs gives it. */
    alias?: string;
};

/** A blocker card about the environment's repositories (environment-blockers.ts membershipBlockerGroups). */
export type RuntimeMembershipBlockerGroupView = Omit<RuntimeBlockerGroupView, 'fixes'> & { fixes: RuntimeMembershipFixView[] };

export interface RuntimeBlockerGroupView {
    signature: string;
    kind: string;
    title: string;
    count: number;
    lastAt?: string;
    lastPr?: number;
    state: 'open';
    evidence?: BlockerEvidence;
    /** What Kody's learn loop already tried on this signature, in order, each with how it ended (docs §5 Blocker.tried); absent: nothing yet. */
    tried?: string[];
    /** In order; the first is the recommended one (ADR-015). */
    fixes: RuntimeBlockerFixView[];
}

