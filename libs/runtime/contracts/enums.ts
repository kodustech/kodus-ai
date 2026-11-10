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

/** Blocker kinds of docs §4 (classifier of blockers). */
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
] as const;
export const BlockerKindSchema = z.enum(BLOCKER_KINDS);
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** The signature of a security_violation blocker: the alert kind, lower snake case (e.g. credential_exfiltration). */
export const SECURITY_VIOLATION_SIGNATURE = /^[a-z][a-z0-9_]{0,63}$/;

/** What the gate decides for one probe (ADR-050). */
export const VERDICTS = ['finding', 'pre_existing', 'not_reproduced', 'inconclusive', 'blocker', 'unverified'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** ADR-017: pixels alone ask a question; they never prove a regression. */
export const VISUAL_CHANGE_ONLY_REASON = 'Visual change only. Is this appearance change intended?';

export const FINDING_KINDS = ['behavior_change', 'pr_destabilizes_machine'] as const;
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

/** Who holds a claim; each has its own lease (TTL) and hard expiry. */
export const CLAIM_CONSUMERS = ['runtime', 'setup', 'mcp', 'custom_agent'] as const;
export type ClaimConsumer = (typeof CLAIM_CONSUMERS)[number];

/** What started a Run. */
export const RUN_TRIGGERS = ['pull_request', 'comment', 'run_again', 'simulate', 'external_finding'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Conclusions of a Git check run. */
export const CHECK_CONCLUSIONS = ['success', 'failure', 'neutral', 'skipped', 'action_required', 'cancelled', 'timed_out'] as const;
export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

export const CELL_OWNERS = ['kodus', 'customer'] as const;
export type CellOwner = (typeof CELL_OWNERS)[number];

/**
 * The Runtime recipe files, in the order they are read from the default branch
 * (§6, ADR-012): the Runtime-only recipe first, then the shared one.
 */
export const RECIPE_FILE_PATHS = ['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml'] as const;
export type RecipeFilePath = (typeof RECIPE_FILE_PATHS)[number];

/**
 * A changed file under `.kodus/` at the repository root: what the product
 * reports from the PR's whole file list (S-19), so the worker can tell which
 * of them are the recipe the Run boots with (`recipeFilesChangedBy`). Only
 * the workspace file is replaced on a PR's checkout (and Kody's authored
 * files, when the setup recorded them); the compose and Dockerfiles a
 * workspace names (kr-grafana: `.kodus/compose.yaml`,
 * `.kodus/Dockerfile.backend`) are booted and built from the PR's checkout.
 */
export const RECIPE_CHANGED_PATH = /^\.kodus\/[A-Za-z0-9._@+-][A-Za-z0-9._@+\/-]{0,199}$/;
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
 * The recipe files among a PR's changed paths (S-19): the ones whose PR copy
 * the Run never boots (ADR-012), so a change to them is only reported. They
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
 * the base repository (a fork, ADR-030): `skip` starts no Run,
 * `require_approval` waits for a maintainer, `run` starts it at once. Every
 * fork Run runs on the fork budget (api/domain/fork-policy.ts).
 */
export const FORK_PULL_REQUEST_POLICIES = ['skip', 'require_approval', 'run'] as const;
export type ForkPullRequestPolicy = (typeof FORK_PULL_REQUEST_POLICIES)[number];
export const DEFAULT_FORK_PULL_REQUEST_POLICY: ForkPullRequestPolicy = 'require_approval';
export const isForkPullRequestPolicy = (v: unknown): v is ForkPullRequestPolicy =>
    typeof v === 'string' && (FORK_PULL_REQUEST_POLICIES as readonly string[]).includes(v);
