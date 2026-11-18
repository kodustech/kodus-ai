import type { KeptCheckOutcome } from '@libs/runtime/contracts/kept-check';
import type {
    RecipeChangedPath,
    RunTrigger,
} from '@libs/runtime/contracts/enums';

import type { RunBootFailure } from './boot-failure';
import type { ClaimReadyTiming } from './environment-setup';

import type { RunReproduction } from './reproduction';
import type { ReportExercised, Uncovered } from './run-report';
import type {
    CheckConclusion,
    ProbeVerdict,
    RunState,
    VerdictState,
} from './run-state';

// The Run projection in the Runtime Postgres (`runtime.runtime_runs`, docs §8,
// adapters/pg-run-projection.store.ts). The runtime-worker writes it from the
// same DBOS step as each transition; the API and the product worker only read
// it, with the read-only role. The DBOS workflow is the source of truth.

export interface RuntimeRunProjection {
    runId: string;
    attempt: number;
    correlationId: string;
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    /** PR target ref recorded at admission; legacy Runs remain absent, never backfilled. */
    baseBranch?: string;
    /**
     * The PR's title when the Run was requested, one clean line of untrusted
     * text (pr-title.ts displayPrTitle), shown as text only: the Runs list
     * names the Run by it. In `report` (not a column: nothing filters or sorts
     * on it). Older Runs and requests without a title have none, never backfilled.
     */
    prTitle?: string;
    environmentId: string;
    imageId: string;
    state: RunState;
    verdictState?: VerdictState;
    phase?: string;
    reason?: string;
    check?: { conclusion: CheckConclusion; title: string };
    findings?: ProbeVerdict[];
    probes?: ProbeVerdict[];
    uncoveredEntryPoints?: string[];
    /** Why each of `uncoveredEntryPoints` was not tested (run-report.ts UncoveredSchema), as the PR comment says it. */
    uncovered?: Uncovered[];
    /** What started the Run: a PR event, an `@kody runtime` comment, Run again, or a simulation. */
    trigger?: RunTrigger;
    /** Each finding's redacted observer probe and historical recipe metadata; public reproduction exports data only. */
    reproduction?: RunReproduction;
    /**
     * Why the Run halted: where a canary was seen (ADR-043), or the side whose
     * claim the cell reported exfiltrating (kind exfiltration, signature = the
     * alert kind). Never the value or the host.
     */
    securityEvent?: {
        kind: 'canary' | 'exfiltration';
        where: string;
        at: string;
        signature?: string;
    };
    cellOwner?: 'kodus' | 'customer';
    /**
     * The recipe the Run booted with: the one the environment setup recorded
     * from the default branch (§6), never the PR's copy. `prChangesRecipe`
     * marks a PR that edits `.kodus/workspace.yaml` (that edit is not used).
     */
    recipe?: {
        sha: string;
        state: 'found' | 'absent';
        digest?: string;
        prChangesRecipe: boolean;
    };
    /**
     * Recipe files the PR changes whose PR copy the Run never boots (S-19,
     * recipeFilesChangedBy). The comment, the check and the Run page say that
     * the base's recipe is used instead.
     */
    recipeChangedInPr?: RecipeChangedPath[];
    /**
     * The PR is in this member repository of a multi-repository environment:
     * its recipeChangedInPr were not applied at all (only the primary's recipe boots).
     */
    recipeChangedInMember?: string;
    /**
     * nothing_to_test: each changed file and why a parser judged that it
     * changes nothing that runs (entry-points/no-effect.ts). The comment and
     * the Run page name them.
     */
    noRuntimeEffect?: { file: string; why: string }[];
    /** Which changed lines ran (run-report.ts ReportExercisedSchema); in `report`, absent on older Runs. */
    exercised?: ReportExercised;
    /**
     * What this Run made of each kept check it carried (docs/runtime/kept-checks.md §5), in
     * the order played; in `report`. Absent: the Run carried none.
     */
    keptChecks?: KeptCheckOutcome[];
    publishStartedAt?: string;
    published?: string[];
    requestedAt: string;
    startedAt?: string;
    /**
     * When the machines were asked for; the 45 min limit counts from here (§3).
     * A Run that waited for room on a cell moves it to when both sides had
     * room (ADR-070): the wait is not boot time.
     */
    bootingAt?: string;
    /**
     * While the Run waits for room on a cell (phase `capacity`, ADR-070): the
     * side that waits, since when, and what the cell said (memory the claim
     * needs and has free, claims that asked first). null once it had room.
     */
    capacityWait?: {
        side: 'base' | 'pr';
        since: string;
        /** The last refusal; the 45 min limit counts from no earlier than this while the Run waits. */
        at?: string;
        signature: string;
        message: string;
        cellId?: string;
        needMb?: number;
        freeMb?: number;
        allocatableMb?: number;
        ahead?: number;
        /** no_capacity: the hosts that could take the claim, all full (CapacityWait.hosts). */
        hosts?: number;
        /** org_capacity: the most machines the org may hold on shared hosts at once. */
        cap?: number;
        /** When the first of those machines is given back at the latest (an upper bound). */
        nextFreeAt?: string;
    } | null;
    /** How long the Run waited for room before its machines booted, in ms (ADR-070). */
    capacityWaitMs?: number;
    /**
     * From bootingAt until both sides were ready, in ms: the environment's
     * time to ready. Set only when both booted; a side that could not boot
     * has no ready time to count.
     */
    bootMs?: number;
    /** Each side's claim.ready.timing (the cell's prepare time and the driver's boot phases), when its cell reported one. */
    bootTiming?: Partial<Record<'base' | 'pr', ClaimReadyTiming>>;
    /**
     * The comment's phases on this Run, in ms, set when both sides booted:
     * `boot` until the base was ready, `apply` how much longer the PR took.
     * The environment's next Runs estimate their own from these.
     */
    phaseMs?: { boot: number; apply: number };
    /**
     * Where each side's image builds spent their time, as BuildKit measured
     * them (claim.ready timing.buildSteps), for the sides whose cell sent it.
     * Step names are Dockerfile lines, redacted and cut to 160 characters.
     */
    buildSteps?: RunBuildSteps[];
    /**
     * The commands the agent ran on the base machine to look around before it
     * wrote its probes, in order. Each one's output (redacted, bounded) is
     * evidence at {orgId}/{runId}/base/{stepId}/output; the model's own
     * words are never kept.
     */
    exploration?: ExploredCommand[];
    /**
     * A plan the agent made while the PR side booted, never used because the
     * PR side did not boot (or the Run ended first): what it spent, so the
     * overlap's cost shows on the Run (run-orchestrator.ts, early-plan.ts).
     */
    unusedPlan?: { inputTokens: number; outputTokens: number; probes: number };
    /**
     * Why the side that decided the Run did not boot (could_not_boot, a PR that
     * does not boot, or a PR boot the cell could not finish): the catalog's
     * cause, the line it read it from and the tail of the build or compose
     * output, redacted (boot-failure.ts). Shown only: no verdict reads it.
     */
    bootFailure?: RunBootFailure;
    /** A side whose builds ran with no cache: the cell had evicted the environment's build state (when). The comment and the page say so. */
    coldBuild?: { side: 'base' | 'pr'; cause: 'build_state_evicted'; evictedAt: string };
    finishedAt?: string;
    updatedAt: string;
}

/** One side's boot builds, step by step (see `buildSteps`). */
export interface RunBuildSteps {
    side: 'base' | 'pr';
    /** Steps over every build of the boot, those that finished, came from the cache, failed. */
    steps: number;
    done: number;
    cached: number;
    errored: number;
    /** The steps that ran longest (cached ones did not run), slowest first, at most 8. */
    slowest: Array<{ service: string; name: string; ms: number }>;
}

/** One command the agent ran on the base machine while it explored (see `exploration`). */
export interface ExploredCommand {
    /** Its place in the agent's list. */
    index: number;
    /** The exec step: the key of its output evidence. */
    stepId: string;
    /** As the agent wrote it, token patterns and canaries redacted, at most 300 characters. */
    command: string;
    /** The command's exit status; absent when it never ran (see `error`). */
    exitCode?: number;
    /** Why the command never ran or never answered (the environment's error code). */
    error?: string;
    durationMs?: number;
    /** A non-zero exit, or an error: what the agent read is not what the app has. */
    failed: boolean;
}

export interface RunKey {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
}

export interface RunListFilter {
    organizationId: string;
    repositoryId?: string;
    /** Only these repositories (the caller's repository scope). An empty list matches nothing. */
    repositoryIds?: string[];
    prNumber?: number;
    environmentId?: string;
    /** Runs requested at or after this ISO time. */
    requestedSince?: string;
    /** Only Runs started this way. */
    trigger?: RunTrigger;
    limit?: number;
}

/** Scopes a read to one tenant: a Run of another org reads as absent. */
export interface RunScope {
    organizationId: string;
}

/** Bounded reads must pass cancellation and client/server deadlines to the backend. */
export interface RunReadOptions {
    timeoutMs: number;
    signal?: AbortSignal;
    view?: 'external_verification';
}

/** What a reader of the projection may do (the API, the product worker): never write (ADR-025). */
export interface RunProjectionReader {
    get(
        runId: string,
        scope?: RunScope,
        options?: RunReadOptions,
    ): Promise<RuntimeRunProjection | null>;
    /** Runs of this PR that are not terminal yet. */
    findLive(key: RunKey): Promise<RuntimeRunProjection[]>;
    list(filter: RunListFilter): Promise<RuntimeRunProjection[]>;
    /** Live Runs of one org, or of every org (the global stop). */
    listLive(organizationId?: string): Promise<RuntimeRunProjection[]>;
}

/** The runtime-worker's side: it alone writes the projection. */
export interface RunProjectionStore extends RunProjectionReader {
    upsert(runId: string, patch: Partial<RuntimeRunProjection>): Promise<void>;
    /**
     * Moves the Run to `patch.state` with the rest of the patch, in one
     * conditional write: only while the Run is not terminal, or already in
     * that same state (a step that died after writing it). False when another
     * writer ended the Run first: nothing of the patch is written.
     */
    moveState(runId: string, patch: Partial<RuntimeRunProjection> & Pick<RuntimeRunProjection, 'state'>): Promise<boolean>;
}

/** States of a Run that still holds (or waits for) machines. */
export const LIVE_RUN_STATES: readonly RunState[] = [
    'queued',
    'awaiting_approval',
    'booting',
    'testing',
];

export const MAX_RUN_LIST_LIMIT = 200;
