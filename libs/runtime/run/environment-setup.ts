// The setup of an environment (runtime.environment.setup_requested), as the
// runtime-worker records it in the Runtime Postgres next to runtime_runs
// (runtime.runtime_environment_setups). The API reads it
// for Environment Health (progress and blockers) and for the expose list a
// "Run again" carries; it never writes it (ADR-025).

import { nulJoinedHex, uuidV4ShapeFrom } from '@libs/runtime/contracts/derive-id';

import type { FixAction, RecipeChange } from '@libs/runtime/blockers/catalog';
import type { AuthoredFile } from '@libs/runtime/contracts/authored-files';
import type { Expose } from '@libs/runtime/contracts/enums';
import type { MachineSize } from '@libs/runtime/contracts/machine-size';
import type { RecipeInferenceGap, SetupRecipeOrigin } from '@libs/runtime/contracts/runtime-commands';
import type { BootPhases, FailureBundle, MessageBody } from '@libs/runtime/protocol';

export type EnvironmentSetupState = 'setting_up' | 'active' | 'blocked';
export type EnvironmentSetupStepName = 'requested' | 'resolve_ref' | 'recipe' | 'boot' | 'ready' | 'bake' | 'pool' | 'release';
export type EnvironmentSetupStepState = 'running' | 'done' | 'failed' | 'skipped';

export interface EnvironmentSetupStep {
    name: EnvironmentSetupStepName;
    state: EnvironmentSetupStepState;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    /** Short, product-safe detail (never repository text). */
    detail?: string;
    /** The repair of Kody's recipe this step belongs to (EnvironmentSetupRepair.n); absent: the setup's first try. */
    repair?: number;
    /**
     * The boot step only: where the boot spent its time, slowest first, at
     * most 8 (the base image pull, each RUN, the export of the layers,
     * moving the image into Docker, compose up, the first healthy answer).
     * From claim.ready, or from claim.failed or the boot's last progress
     * when it did not come up; `running` marks the phase it stopped in.
     */
    phases?: BootPhases;
}

export interface EnvironmentSetupBlocker {
    kind: string;
    signature: string;
    message: string;
    at: string;
    /** The repository of a multi-repository environment the blocker is about (its alias); absent: the environment's own, or not known. */
    alias?: string;
}

/** One repository a multi-repository setup booted: the commit the product resolved, never a token. */
export interface EnvironmentSetupWorkspaceRef {
    repositoryId: string;
    alias: string;
    role: 'primary' | 'member';
    sha: string;
    branch: string;
}

export interface EnvironmentRecipeRecord {
    path: string;
    sha: string;
    state: 'found' | 'absent';
    digest?: string;
    content?: string;
    /** services.compose.public and .health of the recipe: the ready check. */
    public?: string;
    health?: string;
    /** services.compose.health_timeout, in seconds: how long the ready check waits. */
    healthTimeoutSeconds?: number;
    /**
     * 'inferred': the default branch had no recipe and Kodus wrote this one
     * from the repository files. 'authored': nor could it be inferred, and
     * Kody's agent wrote it. Absent: read from the repository.
     */
    origin?: SetupRecipeOrigin;
    /**
     * ENV-06: setups in a row that booted this inferred or authored recipe
     * (same digest) from zero, each on a fresh setup claim, and answered the
     * ready check. The recipe PR is offered from 2.
     */
    cleanBoots?: number;
    /** What Kody said about the choices of an authored recipe (one or two sentences, model text). */
    notes?: string;
    /**
     * The version of the author's instructions that wrote an authored recipe
     * (libs/runtime/run/recipe-author-version.ts). Absent: written before
     * versions were recorded (version 1).
     */
    authorVersion?: number;
    /**
     * The Dockerfiles and compose files under .kodus/ Kody wrote with an
     * authored recipe, checked with it at `sha`. Every boot of this recipe
     * (the setup's and every Run's) gets them in claim.acquire; `digest`
     * covers them with the recipe.
     */
    files?: AuthoredFile[];
    /**
     * What Kodus rewrote in Kody's compose files before the checks passed them
     * (dropped container_name, inlined extends, dropped a missing env_file),
     * in Kodus's words; `files` already holds the rewritten text.
     */
    adjusted?: string[];
    /** Why Kodus could not infer a recipe (state 'absent'); the message is product-authored. */
    inference?: { reason: RecipeInferenceGap; message: string };
}

export interface EnvironmentSetupProgress {
    phases: Array<{ phase: string; state: 'started' | 'done'; at: string; ms?: number }>;
    lines: string[];
    updatedAt: string;
    /** Where the boot spent its time so far (claim.progress phases). */
    bootPhases?: BootPhases;
}

export interface EnvironmentSetupRecord {
    environmentId: string;
    organizationId: string;
    repositoryId: string;
    /** Idempotency key of the command that started this setup. */
    key: string;
    state: EnvironmentSetupState;
    steps: EnvironmentSetupStep[];
    blockers: EnvironmentSetupBlocker[];
    sha?: string;
    branch?: string;
    /** Every repository of a multi-repository environment and the commit this setup booted it at; absent for one repository. */
    workspace?: EnvironmentSetupWorkspaceRef[];
    /**
     * The key of the bake this setup's cell accepted for a multi-repository
     * environment (every repository's commit and the recipe). The cell's
     * image id names only the primary's commit, so this record is what tells
     * which commits the environment's bake holds.
     */
    bakeRefsDigest?: string;
    /** Where the commit came from: the product's default-branch head, or the worker's explicit dev override. */
    refSource?: 'default_branch' | 'dev_override';
    /**
     * The recipe this environment boots with, read by the product from the
     * default branch at `sha` (§6). PR Runs use this one, never the PR's copy.
     * `content` stays in the Runtime store; the API shows only path, sha, state and digest.
     */
    recipe?: EnvironmentRecipeRecord;
    /**
     * The machine size the setup booted with (the environment's setting when
     * it was requested); Runs and sessions on this setup boot at it too.
     * Absent: the cell's default.
     */
    machineSize?: MachineSize;
    cellId?: string;
    /** The cell of the last boot that reached one, even a failed one: it holds the environment's build state and cache. */
    buildCellId?: string;
    imageId?: string;
    /** The services the booted environment exposes (from the claim manifest). */
    expose?: Expose[];
    /**
     * What the cell collected when the setup failed (§11 runbook): service
     * states, the last log lines per service, ports, disk and denied egress,
     * already redacted by the cell (S-51).
     */
    failureBundle?: FailureBundle;
    /** The failed setup's machines kept for the dev's agent until `until` (no verdict probes). */
    diagnosticHold?: { claimId: string; cellId: string; until: string };
    /** Kody's learn loop on this blocked setup (docs "Ciclo de aprender"); absent when it did not run. */
    learn?: EnvironmentLearnRecord;
    /**
     * Each time Kody rewrote its own recipe inside this setup after its boot
     * failed on the recipe's account (RUNTIME_SETUP_AUTHOR_REPAIRS), oldest
     * first. Absent: no repair ran. The record's recipe, state and blockers
     * are the last attempt's.
     */
    repairs?: EnvironmentSetupRepair[];
    /**
     * The last time Kody was asked to write the environment's recipe again
     * because the author's instructions changed (recipe-author-version.ts):
     * for which version, from which, why, and how it ended (`updated`: the new
     * recipe boots from here; `unchanged`: Kody kept it as it was; `kept`: the
     * new one did not pass its checks and the old one stays). Carried from setup
     * to setup: one attempt per version and environment.
     */
    reauthor?: { version: number; from: number; reason: string; outcome: 'updated' | 'unchanged' | 'kept' };
    /**
     * Where the boot is while it runs, as the cell reports it (claim.progress):
     * each phase of the machine's preparation and the last lines of the running
     * one (a build's output), redacted by the cell. Kept after the boot ends.
     */
    progress?: EnvironmentSetupProgress;
    /**
     * The last setup of this environment that became active: how long it
     * took from request to active, and each boot phase. Carried from setup to
     * setup, so the one running says what to expect.
     */
    lastActive?: EnvironmentLastActive;
    /** The cell's claim.ready.timing of this setup's boot (prepare and the driver's phases), when it reported one. */
    bootTiming?: ClaimReadyTiming;
    /**
     * The environment's recent setup boots (its own claim, never the learn
     * loop's tries), carried from setup to setup: the last 7 days, at most
     * SETUP_BOOTS_KEPT. Environment Health counts them (setupBoots).
     */
    boots?: EnvironmentSetupBoot[];
    requestedAt: string;
    updatedAt: string;
    finishedAt?: string;
}

/**
 * One repair of an authored recipe inside a setup: the boot of Kody's recipe
 * failed on the recipe's account, the failure went back to Kody as `last`,
 * and Kody's new recipe booted on a new claim. `writing`: Kody is writing it;
 * `booting`: its boot runs; `booted` / `blocked`: how that boot ended. The
 * others stopped the repairs with no boot: Kody wrote none (`no_recipe`), the
 * same recipe and files that failed (`identical`), one the worker's checks
 * refuse (`refused`), or Kody was not reached (`unavailable`, `budget`).
 */
export interface EnvironmentSetupRepair {
    /** 1..max, in this setup. */
    n: number;
    /** The most repairs this setup could make. */
    max: number;
    /** What stopped the boot Kody rewrote the recipe after, as the catalog classified it; `cause` is its message's cause line, when it has one. */
    blocker: { kind: string; signature: string; title: string; cause?: string };
    /** The digest of the recipe (and its files) whose boot failed. */
    failedDigest: string;
    /** The digest of Kody's new recipe and files; absent when Kody wrote none. */
    recipeDigest?: string;
    /** no_token: no fresh download token for the new boot (the cell revoked the last boot's), so Kody was not asked.
     *  same_failure: Kody's last rewrite failed exactly as the recipe it replaced, so Kody was not asked again. */
    outcome: 'writing' | 'booting' | 'booted' | 'blocked' | 'no_recipe' | 'identical' | 'refused' | 'unavailable' | 'budget' | 'no_token' | 'same_failure';
    at: string;
}

/** How many times a setup rewrites Kody's recipe after its boot failed, unless the worker sets RUNTIME_SETUP_AUTHOR_REPAIRS. */
export const SETUP_AUTHOR_REPAIRS_DEFAULT = 2;
/** The most RUNTIME_SETUP_AUTHOR_REPAIRS may ask: each repair is an author run and a boot from zero. */
export const SETUP_AUTHOR_REPAIRS_MAX = 5;

/** claim.ready.timing, in ms (the protocol's schema is the source of truth). */
export type ClaimReadyTiming = NonNullable<MessageBody<'claim.ready'>['timing']>;

/** One setup boot: claim.acquire until the claim was ready (or failed), in ms. */
export interface EnvironmentSetupBoot {
    /** When the boot step ended. */
    at: string;
    outcome: 'ready' | 'failed';
    ms: number;
    /** The blocker's signature of a failed boot. */
    signature?: string;
}

export const SETUP_BOOTS_KEPT = 50;
export const SETUP_BOOTS_WINDOW_MS = 7 * 24 * 3_600_000;
/** Refusals before any cell booted anything (capacity, size): no boot was attempted, so none is counted. */
export const NOT_A_SETUP_BOOT: ReadonlySet<string> = new Set(['org_capacity', 'no_capacity', 'size_unavailable', 'machine_minutes_exhausted', 'isolation_unavailable']);

/**
 * Whether a blocked setup's first blocker is a failure of its recipe, the
 * kind Kody rewrites the recipe from on the next setup. Kodus's own platform,
 * a refusal before any cell booted anything (capacity, size) and a missing
 * cell are no verdict on the recipe. The web keeps a copy of this rule
 * (apps/web model/environment.ts), pinned to this one by a parity test.
 */
export function isRecipeFailureBlocker(b: { kind: string; signature: string } | undefined): boolean {
    if (!b) return false;
    return !(b.kind === 'platform' || b.kind === 'cell_unavailable' || b.signature === 'cell_unavailable' || NOT_A_SETUP_BOOT.has(b.signature));
}

/**
 * The boots with the one this setup's boot step just ended, kept to the
 * window and the cap (oldest out first). A step that has not ended, or a
 * refusal that booted nothing, leaves them as they were.
 */
export function withSetupBoot(boots: readonly EnvironmentSetupBoot[] | undefined, step: Pick<EnvironmentSetupStep, 'finishedAt' | 'durationMs'>, outcome: EnvironmentSetupBoot['outcome'], signature?: string): EnvironmentSetupBoot[] {
    const kept = [...(boots ?? [])];
    if (!step.finishedAt || typeof step.durationMs !== 'number' || (signature && NOT_A_SETUP_BOOT.has(signature))) return kept;
    const at = Date.parse(step.finishedAt);
    const boot: EnvironmentSetupBoot = { at: step.finishedAt, outcome, ms: Math.max(0, step.durationMs), ...(signature ? { signature: signature.slice(0, 256) } : {}) };
    return [...kept, boot].filter((b) => Date.parse(b.at) > at - SETUP_BOOTS_WINDOW_MS).slice(-SETUP_BOOTS_KEPT);
}

export interface EnvironmentLastActive {
    finishedAt: string;
    /** From requestedAt to active. */
    totalMs: number;
    phases: Array<{ phase: string; ms: number }>;
}

/** What a setup that just became active leaves for the next one to compare against. */
export function lastActiveOf(rec: EnvironmentSetupRecord): EnvironmentLastActive | undefined {
    if (rec.state !== 'active' || !rec.finishedAt) return undefined;
    const totalMs = Date.parse(rec.finishedAt) - Date.parse(rec.requestedAt);
    if (!Number.isFinite(totalMs) || totalMs < 0) return undefined;
    const phases = (rec.progress?.phases ?? []).filter((p) => p.state === 'done' && typeof p.ms === 'number').map((p) => ({ phase: p.phase, ms: p.ms! }));
    return { finishedAt: rec.finishedAt, totalMs, phases };
}

/** The typed fix one attempt tried, in Kodus's words (S-23): never the LLM's text. */
export interface EnvironmentLearnFix {
    id: string;
    action: FixAction;
    label: string;
}

/**
 * One hypothesis of the learn loop. `trying`: the attempt is booting;
 * `booted`: it booted from zero twice (ENV-06); `booted_once`: the first boot
 * answered and the replay did not; `blocked`: it did not boot; `refused`: the
 * LLM's answer was not a hypothesis Kodus could try, nothing booted.
 */
export interface EnvironmentLearnAttempt {
    /** 1..3 for its blocker signature. */
    n: number;
    signature: string;
    fix?: EnvironmentLearnFix;
    result: 'trying' | 'booted' | 'booted_once' | 'blocked' | 'refused';
    refusal?: 'not_json' | 'not_allowed' | 'not_in_evidence' | 'already_set' | 'not_higher' | 'unknown_service' | 'duplicate' | 'edit_failed';
    cleanBoots?: number;
    /** What stopped a blocked attempt, as the catalog classifies it (template title). */
    blocker?: { kind: string; signature: string; title: string };
    /** The setup it ran in. */
    setupKey: string;
    at: string;
}

export interface EnvironmentLearnRecord {
    /** Hypotheses asked per blocker signature, carried from setup to setup: at most 3, then the card stays. */
    tried: Array<{ signature: string; count: number }>;
    /** This blocker's attempts, the earlier setups' included. */
    attempts: EnvironmentLearnAttempt[];
    /** Why the loop stopped this time; `no_token`: the product gave no new download tokens for a clean boot (the setup's own were spent). */
    stopped?: 'proven' | 'cap' | 'cannot_fix' | 'nothing_to_try' | 'budget' | 'llm_unavailable' | 'no_token';
    /**
     * The fix that booted from zero on two clean machines. The default-branch
     * recipe is not changed: the dev opens the PR (the recipe PR for an
     * inferred recipe, the one-field fix PR otherwise).
     */
    proven?: {
        signature: string;
        fix: EnvironmentLearnFix;
        change: RecipeChange;
        /** The recipe it booted with (the setup's recipe plus the change), and its digest. */
        content: string;
        digest: string;
        cleanBoots: number;
        origin: 'inferred' | 'repository';
    };
}

/**
 * The id the gateway budgets a setup's learn loop under (its "Run" scope):
 * UUID-shaped like a runId, derived from the setup key so a resumed workflow
 * and the product compute the same one.
 */
export const setupLearnScopeId = (key: string) => uuidV4ShapeFrom(nulJoinedHex(['kody-runtime/setup-learn', key]));
