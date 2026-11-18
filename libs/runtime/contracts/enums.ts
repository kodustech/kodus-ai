import { z } from 'zod';

// The vocabulary shared by the cell protocol, the product↔Runtime messages,
// the gate and the report, defined once. Everything else derives its type
// from here (z.infer), so a new kind is added in one place.

export const EXPOSE_KINDS = ['http', 'postgres', 'mysql', 'grpc'] as const;
export type ExposeKind = (typeof EXPOSE_KINDS)[number];

/** A service the environment exposes to the observer. */
export const ExposeSchema = z.strictObject({
    service: z.string().min(1).max(128),
    port: z.number().int().min(1).max(65_535),
    kind: z.enum(EXPOSE_KINDS),
});
export type Expose = z.infer<typeof ExposeSchema>;

/** What blocked a boot, as the blocker classifier names it. */
export const BLOCKER_KINDS = [
    'missing_env',
    'external_service',
    'toolchain',
    'native_dep',
    'resources',
    'seed_data',
    'other_repo',
    'platform',
    'recipe_outdated',
    'unknown',
    /**
     * The cell saw the claim's code exfiltrate (its test credential or a bait
     * the cell planted, sent to a host it was not issued for). The claim runs
     * nothing more and the Run halts. Signature: SECURITY_VIOLATION_SIGNATURE.
     */
    'security_violation',
    /**
     * No connected cell offers what the claim needs to run at all (an
     * isolation minimum no cell satisfies): nothing was sent to a cell and
     * nothing in the repository is the cause. Never placed on a lower cell.
     */
    'capacity',
] as const;
export const BlockerKindSchema = z.enum(BLOCKER_KINDS);
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** The signature of a security_violation blocker: the alert kind, lower snake case (e.g. credential_exfiltration). */
export const SECURITY_VIOLATION_SIGNATURE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * What the gate decides for one probe. `new_endpoint`: a route the diff adds,
 * absent on main (404 or 405 on every round of a base whose ready check
 * answered) and answered under 500 on the PR. New behavior, not a regression:
 * it settles its entry point and never fails the check (gate decideNewEndpoint).
 */
export const VERDICTS = ['finding', 'pre_existing', 'not_reproduced', 'inconclusive', 'blocker', 'unverified', 'new_endpoint'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Pixels alone ask a question; they never prove a regression. */
export const VISUAL_CHANGE_ONLY_REASON = 'Visual change only. Is this appearance change intended?';

/**
 * `new_endpoint_error`: a route the diff adds, absent on main, answers 5xx on
 * the PR. A finding on the new code (it fails the check), not a difference
 * from main's behavior.
 */
export const FINDING_KINDS = ['behavior_change', 'pr_destabilizes_machine', 'new_endpoint_error'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Set by the intent classifier; intended findings never lead to success. */
export const FINDING_INTENTS = ['unintended', 'uncertain', 'intended'] as const;
export type FindingIntent = (typeof FINDING_INTENTS)[number];

/** Health of the machine a step ran against (step.result.vmHealth). */
export const VM_HEALTH = ['ok', 'oom', 'crashed', 'unreachable'] as const;
export type VmHealth = (typeof VM_HEALTH)[number];

/** The two sides a probe compares. */
export const PROBE_SIDES = ['base', 'pr'] as const;
export type ProbeSide = (typeof PROBE_SIDES)[number];

/** What a claim boots: one side of a PR, or a default-branch setup. */
export const CLAIM_SIDES = ['base', 'pr', 'setup'] as const;
export type ClaimSide = (typeof CLAIM_SIDES)[number];

/** Every state a claim (runtime_claims.state) can be in. */
export const CLAIM_STATES = ['pending', 'bound', 'held', 'blocked', 'failed', 'compromised', 'released', 'terminated'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

/**
 * Every move a claim can make; both hub stores refuse any other. `pending` is
 * where a claim starts and where a new acquire round (a retry with the same
 * key) puts an open claim back, on the cell of the retry. `compromised`: the
 * cell reported a security violation; the claim takes no step and is never
 * rebound, and its machines stay as evidence until the claim is released.
 * `released` and `terminated` (the cell was revoked) are final.
 */
const CLAIM_TRANSITIONS: Record<ClaimState, readonly ClaimState[]> = {
    pending: ['pending', 'bound', 'held', 'blocked', 'failed', 'compromised', 'released', 'terminated'],
    bound: ['pending', 'compromised', 'released', 'terminated'],
    held: ['pending', 'compromised', 'released', 'terminated'],
    blocked: ['pending', 'released', 'terminated'],
    failed: ['pending', 'released', 'terminated'],
    compromised: ['released'],
    released: [],
    terminated: [],
};

export function canClaimTransition(from: ClaimState, to: ClaimState): boolean {
    return CLAIM_TRANSITIONS[from].includes(to);
}

export class InvalidClaimTransitionError extends Error {
    constructor(
        readonly from: readonly ClaimState[],
        readonly to: ClaimState,
    ) {
        super(`invalid claim transition ${from.filter((f) => !canClaimTransition(f, to)).join('|')} -> ${to}`);
    }
}

/** A guarded move names every state it may start from; each one must be allowed to reach `to`. */
export function assertClaimTransition(from: readonly ClaimState[], to: ClaimState): void {
    if (!from.every((f) => canClaimTransition(f, to))) throw new InvalidClaimTransitionError(from, to);
}

/** Every state that may move to `to`, in CLAIM_STATES order. */
export const claimStatesInto = (to: ClaimState): readonly ClaimState[] => CLAIM_STATES.filter((s) => canClaimTransition(s, to));

/** A claim that holds (or is about to hold) machines on a cell and takes steps: what counts against a cell's slots and an org's cap. */
export const LIVE_CLAIM_STATES: readonly ClaimState[] = ['pending', 'bound', 'held'];

export const isFinalClaimState = (s: ClaimState) => CLAIM_TRANSITIONS[s].length === 0;

/** Every state but the two final ones. */
export const OPEN_CLAIM_STATES: readonly ClaimState[] = CLAIM_STATES.filter((s) => !isFinalClaimState(s));

/** The claims a new acquire round may rebind: every open one but a compromised one. */
export const REBINDABLE_CLAIM_STATES: readonly ClaimState[] = claimStatesInto('pending');

/**
 * A claim whose machines still exist on its cell: the live ones and a
 * compromised one (kept as evidence). The cell of a failed or blocked claim
 * has already let go of its machines.
 */
export const MACHINE_HOLDING_CLAIM_STATES: readonly ClaimState[] = ['pending', 'bound', 'held', 'compromised'];

/**
 * The claims a cell's revocation terminates: every open one but a
 * compromised one, which stays as evidence until it is released.
 */
export const REVOCATION_TERMINATED_CLAIM_STATES: readonly ClaimState[] = claimStatesInto('terminated');
/** Whether a claim state (typed or read as text from a row) is one of `states`. */
export const isClaimStateIn = (states: readonly ClaimState[], s: string): boolean => (states as readonly string[]).includes(s);

/** Who holds a claim; each has its own lease (TTL) and hard expiry. */
// sandbox: a code sandbox (docs/runtime/sandbox.md), one tool container and no Run.
// preview: one side of a finished Run booted again for a person to open in a
// browser (docs/runtime/preview-urls.md), never the Run's own machines.
export const CLAIM_CONSUMERS = ['runtime', 'setup', 'mcp', 'custom_agent', 'sandbox', 'preview'] as const;
export type ClaimConsumer = (typeof CLAIM_CONSUMERS)[number];

/** What started a Run. */
export const RUN_TRIGGERS = ['pull_request', 'comment', 'run_again', 'simulate', 'external_finding'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Conclusions of a Git check run. */
export const CHECK_CONCLUSIONS = ['success', 'failure', 'neutral', 'skipped', 'action_required', 'cancelled', 'timed_out'] as const;
export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

/**
 * What a partly tested Run with something left to decide concludes its check
 * with (owner decision of 2026-11-18): `action_required` by default, which a
 * branch protection does not pass, or `neutral`, the org's fallback, which it
 * does. A partly tested Run with nothing to test stays neutral either way, and
 * a PR boot the egress proxy stopped is action_required either way.
 */
export const PARTLY_TESTED_CHECKS = ['action_required', 'neutral'] as const;
export type PartlyTestedCheck = (typeof PARTLY_TESTED_CHECKS)[number];
export const DEFAULT_PARTLY_TESTED_CHECK: PartlyTestedCheck = 'action_required';

export const CELL_OWNERS = ['kodus', 'customer'] as const;
export type CellOwner = (typeof CELL_OWNERS)[number];

/**
 * The Runtime recipe files, in the order they are read from the default
 * branch: the Runtime-only recipe first, then the shared one.
 */
export const RECIPE_FILE_PATHS = ['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml'] as const;
export type RecipeFilePath = (typeof RECIPE_FILE_PATHS)[number];

/**
 * A changed file under `.kodus/` at the repository root: what the product
 * reports from the PR's whole file list, so the worker can tell which
 * of them are the recipe the Run boots with (`recipeFilesChangedBy`). Only
 * the workspace file is replaced on a PR's checkout (and Kody's authored
 * files, when the setup recorded them); the compose and Dockerfiles a
 * workspace names (demo-grafana: `.kodus/compose.yaml`,
 * `.kodus/Dockerfile.backend`) are booted and built from the PR's checkout.
 */
export const RECIPE_CHANGED_PATH = /^\.kodus\/[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]{0,199}$/;
export const MAX_RECIPE_CHANGED_PATHS = 20;
export type RecipeChangedPath = string;

/**
 * The root `.kodus/` files among a PR's changed paths: the workspace files
 * first in their fixed order, then the others sorted, bounded. Not all of
 * them are the recipe; the worker narrows them with `recipeFilesChangedBy`.
 */
export function kodusFilesChangedBy(paths: Iterable<string | undefined>): RecipeChangedPath[] {
    const seen = new Set<string>();
    for (const p of paths) if (p && RECIPE_CHANGED_PATH.test(p) && !p.split('/').includes('..')) seen.add(p);
    const workspace: string[] = RECIPE_FILE_PATHS.filter((f) => seen.has(f));
    const others = [...seen].filter((p) => !workspace.includes(p)).sort();
    return [...workspace, ...others].slice(0, MAX_RECIPE_CHANGED_PATHS);
}

/**
 * The recipe a Run's claims carry (the environment's setup record): the cell
 * writes its workspace content over the checkout's `.kodus/workspace.yaml`
 * (or removes it when the default branch has none), and Kody's authored files
 * into `.kodus/`, refusing a checkout copy with other bytes. Absent, the
 * checkout boots with its own workspace file.
 */
export interface BootRecipe {
    files?: ReadonlyArray<{ path: string }>;
}

/**
 * The recipe files among a PR's changed paths: the ones whose PR copy
 * the Run never boots, so a change to them is only reported. They
 * are the workspace files and the setup's authored files, and only when the
 * claims carry a recipe. Every other `.kodus/` file (a compose, a Dockerfile)
 * is booted from the PR's checkout like any build file: no recipe change.
 */
export function recipeFilesChangedBy(paths: Iterable<string | undefined>, recipe: BootRecipe | undefined): RecipeChangedPath[] {
    if (!recipe) return [];
    const ours = new Set<string>([...RECIPE_FILE_PATHS, ...(recipe.files ?? []).map((f) => f.path)]);
    return kodusFilesChangedBy([...paths].filter((p) => p !== undefined && ours.has(p)));
}

/**
 * What an environment does with a pull request whose head repository is not
 * the base repository (a fork): `skip` starts no Run,
 * `require_approval` waits for a maintainer, `run` starts it at once. Every
 * fork Run runs on the fork budget (api/domain/fork-policy.ts).
 */
export const FORK_PULL_REQUEST_POLICIES = ['skip', 'require_approval', 'run'] as const;
export type ForkPullRequestPolicy = (typeof FORK_PULL_REQUEST_POLICIES)[number];
export const DEFAULT_FORK_PULL_REQUEST_POLICY: ForkPullRequestPolicy = 'require_approval';
export const isForkPullRequestPolicy = (v: unknown): v is ForkPullRequestPolicy =>
    typeof v === 'string' && (FORK_PULL_REQUEST_POLICIES as readonly string[]).includes(v);

/**
 * A repository's place in a multi-repository environment: the `primary` holds
 * the recipe and names the environment; a `member` is booted beside it.
 */
export const ENVIRONMENT_REPOSITORY_ROLES = ['primary', 'member'] as const;
export type EnvironmentRepositoryRole = (typeof ENVIRONMENT_REPOSITORY_ROLES)[number];

/**
 * Where a Run takes a repository's commits from: the pull request itself, the
 * repository's default-branch head (the same commit on both sides), or an
 * open pull request of the same branch name in that repository (paired).
 */
export const WORKSPACE_REF_SOURCES = ['pull_request', 'default_branch', 'paired'] as const;
export type WorkspaceRefSource = (typeof WORKSPACE_REF_SOURCES)[number];
