// Kody Runtime shapes, as the API serves them under /runtime/*.
//
// The shapes come from the API's own types: the response views in
// libs/runtime/contracts/views/*, the pure domain types of libs/runtime and
// libs/runtime-publish, the Run lifecycle of libs/runtime/run/run-state.ts
// and the gate. Every one is `import type`: type imports are erased, so the
// isolated web build does not need those files copied. Where the web reads a
// response more tolerantly (a field an older API omits is optional here), its
// type is derived from the API's with only those fields changed, or checked
// with Assignable, so a field the API renames or drops breaks the web
// typecheck instead of drifting silently. The value lists below are checked
// against the API's types in both directions.
//
// Still the web's own: shapes no pure lib file declares yet (the Run row and
// detail as one RuntimeRun, the org egress, the cells list, the preview
// offers of api/application/use-cases/previews.use-cases.ts).

import type {
    PublicationKindView as LibPublicationKindView,
    RunPublicationView,
} from "@libs/runtime-publish/domain/run-publication-view";
import type { RunTargetWorkspaceRef } from "@libs/runtime-publish/domain/run-target";
import type { PublicationStatus as LibPublicationStatus } from "@libs/runtime-publish/domain/runtime-publication";
import type { RuntimeLlmAgent as LibRuntimeLlmAgent } from "@libs/runtime/api/domain/llm-spend";
import type { RuntimeMachineMinutesToday as LibRuntimeMachineMinutesToday } from "@libs/runtime/api/domain/machine-minutes-today";
import type {
    PoolPolicy as LibPoolPolicy,
    PoolReason as LibPoolReason,
    PoolWeekday as LibPoolWeekday,
} from "@libs/runtime/api/domain/pool";
import type {
    EgressApprovalRow,
    EgressBlockedRow,
    FindingFeedbackValue as LibFindingFeedbackValue,
    RuntimeWhoCanAsk as LibRuntimeWhoCanAsk,
} from "@libs/runtime/api/domain/ports";
import type { RuntimeRunCost as LibRuntimeRunCost } from "@libs/runtime/api/domain/run-cost";
import type {
    HealthCell,
    RuntimeHealth as LibRuntimeHealth,
    RuntimeHealthStuck as LibRuntimeHealthStuck,
    Measured,
    NotMeasured,
} from "@libs/runtime/api/domain/runtime-health";
import type {
    RuntimeSpeed as LibRuntimeSpeed,
    MachineHost,
    MachineSource,
    SpeedMetrics,
    SpeedStat,
    SpeedWindowDays,
} from "@libs/runtime/api/domain/runtime-speed";
import type {
    RuntimeMode as LibRuntimeMode,
    RuleCondition,
    TriggerRule,
} from "@libs/runtime/api/domain/trigger-rules";
import type {
    DurationStats,
    RuntimeUsageReport as LibRuntimeUsageReport,
    MachineUsage,
    UsageReportRun,
} from "@libs/runtime/api/domain/usage-report";
import type { BlockerEvidence as LibBlockerEvidence } from "@libs/runtime/blockers/catalog";
import type {
    CellTokenState,
    CellTopology as LibCellTopology,
} from "@libs/runtime/contracts/cell-token";
import type {
    BlockerKind as LibBlockerKind,
    EnvironmentRepositoryRole as LibEnvironmentRepositoryRole,
    ForkPullRequestPolicy as LibForkPullRequestPolicy,
    WorkspaceRefSource as LibWorkspaceRefSource,
} from "@libs/runtime/contracts/enums";
import type { EvidenceUploadType } from "@libs/runtime/contracts/evidence";
import type {
    MachineSize as LibMachineSize,
    MachineSizePreset as LibMachineSizePreset,
} from "@libs/runtime/contracts/machine-size";
import type {
    PreviewForks as LibPreviewForks,
    PreviewSecrets as LibPreviewSecrets,
    PreviewSide as LibPreviewSide,
    PreviewState as LibPreviewState,
    PreviewSettings,
    PreviewView,
} from "@libs/runtime/contracts/preview";
import type { CellRegistrationTokenView as LibCellRegistrationTokenView } from "@libs/runtime/contracts/views/cells";
import type {
    RuntimeBlockerFixView,
    RuntimeBlockerGroupView,
    RuntimeEnvironmentRepositoryView,
    RuntimeEnvironmentState,
    RuntimeEnvironmentView,
    RuntimeLearnView,
    RuntimeMembershipFixView,
} from "@libs/runtime/contracts/views/environments";
import type { RuntimeLessonView } from "@libs/runtime/contracts/views/lessons";
import type {
    FindingFeedbackView,
    FindingIntentView,
    ProbeRequestView,
    RuntimeRunDetail,
} from "@libs/runtime/contracts/views/run";
import type {
    RuntimeRepositorySettingsView,
    RuntimeSettingsView,
} from "@libs/runtime/contracts/views/settings";
import type { Verdict as LibVerdict } from "@libs/runtime/gate";
import type {
    BootPhases,
    FailureBundle,
} from "@libs/runtime/protocol/messages";
import type {
    ClaimReadyTiming,
    EnvironmentLastActive,
    EnvironmentSetupProgress,
    EnvironmentSetupRepair as LibEnvironmentSetupRepair,
    EnvironmentSetupStep as LibEnvironmentSetupStep,
    EnvironmentSetupStepName as LibEnvironmentSetupStepName,
    EnvironmentSetupStepState as LibEnvironmentSetupStepState,
} from "@libs/runtime/run/environment-setup";
import type {
    ExploredCommand as LibExploredCommand,
    RunBuildSteps as LibRunBuildSteps,
} from "@libs/runtime/run/run-projection";
import type { Uncovered } from "@libs/runtime/run/run-report";
import type {
    CheckConclusion as LibCheckConclusion,
    ProbeVerdict as LibProbeVerdict,
    RunState as LibRunState,
    VerdictState as LibVerdictState,
} from "@libs/runtime/run/run-state";

/** Fails to compile unless A and B are the same union. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
/** Fails to compile unless every A is a B: the API's shape fits the web's more tolerant one. */
type Assignable<A, B> = [A] extends [B] ? true : never;
const assertExact = <T extends true>(_: T) => _;

export type RunState = LibRunState;
export type VerdictState = LibVerdictState;
export type CheckConclusion = LibCheckConclusion;
export type Verdict = LibVerdict;
/**
 * One probe's verdict, with the evidence fields the Run page reads when the
 * backend serves them (`lanes` is in run-state.ts; `responseDiff` and
 * `diffRef` are defined here until it is). Every one is optional: older Runs
 * have none.
 */
export type ProbeVerdict = LibProbeVerdict & {
    /** The fields whose values differ between main's and this PR's answer, redacted and cut. */
    responseDiff?: ResponseDiff;
    /** Where the diff changes the code this probe reaches. */
    diffRef?: DiffRef;
};

/** A field present on one side only has the other side's value absent. */
export type ResponseDiffField = { path: string; base?: string; pr?: string };
export type ResponseDiff = { fields: ResponseDiffField[]; truncated: boolean };
export type DiffRef = { file: string; line?: number };

/** Why one side did not boot: what the cell saw, redacted, and the last log lines. */
/** Why a side waits for room on a host (the projection's capacityWait); every number is optional. */
export type RunCapacityWait = {
    side?: "base" | "pr";
    since?: string;
    /** The last refusal. */
    at?: string;
    /** `no_capacity` or `org_capacity`. */
    signature: string;
    needMb?: number;
    freeMb?: number;
    ahead?: number;
    /** no_capacity: the hosts that could take the machine, all full. */
    hosts?: number;
    /** org_capacity: the most machines the organization may hold on shared hosts. */
    cap?: number;
    /** When the first of those machines frees at the latest. */
    nextFreeAt?: string;
};

export type RunBootFailure = {
    side: "base" | "pr";
    /** A blocker kind (`toolchain`, `external_service`…). */
    kind: string;
    signature: string;
    title: string;
    /** The line that names the error, when the cell found one. */
    errorLine?: string;
    logTail: string[];
    at: string;
};

export const RUN_STATES = [
    "queued",
    "skipped",
    "awaiting_approval",
    "booting",
    "testing",
    "no_regressions",
    "regression",
    "partly_tested",
    "could_not_boot",
    "nothing_to_test",
    "superseded",
    "cancelled",
    "timed_out",
    "errored",
    "halted",
] as const satisfies readonly RunState[];
assertExact<Exact<(typeof RUN_STATES)[number], RunState>>(true);

/** A repository's place in a multi-repository environment: the primary holds the recipe; a member boots beside it. */
export type EnvironmentRepositoryRole = LibEnvironmentRepositoryRole;
/** Where a Run took a repository's commits from: the PR itself, the default branch, or a PR of the same branch name. */
export type WorkspaceRefSource = LibWorkspaceRefSource;

/** One repository of a multi-repository Run and the commits each side booted it at. */
export type RunWorkspaceRef = RunTargetWorkspaceRef;

/** `runtime_runs` projection (docs §8), read-only for the API. */
export type RuntimeRun = {
    runId: string;
    attempt: number;
    correlationId?: string;
    organizationId?: string;
    teamId?: string;
    repositoryId: string;
    repositoryName: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    /** Recorded PR target branch, when served by the product; older Runs omit it. */
    baseBranch?: string;
    /** The PR's title when the Run was requested: untrusted, one clean line, shown as text only; older Runs omit it. */
    prTitle?: string;
    environmentId: string;
    imageId?: string;
    state: RunState;
    verdictState?: VerdictState;
    phase?: string;
    /** While a side waits for room on a host (phase `capacity`), and kept when the wait ended the Run; older Runs omit the numbers. */
    capacityWait?: RunCapacityWait | null;
    reason?: string;
    check?: { conclusion: CheckConclusion; title: string };
    findings?: ProbeVerdict[];
    probes?: ProbeVerdict[];
    uncoveredEntryPoints?: string[];
    cellOwner?: CellOwner;
    publishStartedAt?: string;
    published?: string[];
    requestedAt: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt: string;
    /** Machine time and LLM tokens at list prices, an estimate (§13 PR 5). */
    cost?: RuntimeRunCost;
    /** Findings with a "reproduce on your machine" script, by probeId (detail only). */
    reproducible?: string[];
    /** 👍/👎 per tested path, by probeId (detail only). */
    feedback?: Record<string, FindingFeedback>;
    /**
     * Findings a developer marked "this change is intended", by probeId
     * (detail only). A learning signal: the verdict and the check stay what
     * Kody measured.
     */
    intendedBy?: Record<string, FindingIntentMark>;
    /** The recipe the Run booted with, from the base branch (§6). */
    recipe?: {
        sha: string;
        state: "found" | "absent";
        digest?: string;
        prChangesRecipe: boolean;
    };
    /** Recipe files the PR changes (S-19): the Run used the base's recipe instead. */
    recipeChangedInPr?: string[];
    /** nothing_to_test: each changed file a parser judged to change nothing that runs, and why. */
    noRuntimeEffect?: { file: string; why: string }[];
    /** What the product actually posted on the PR (detail only; libs/runtime-publish/domain/run-publication-view.ts). */
    publication?: RunPublication;
    /** When the machines were asked for (the 45 min limit counts from here). */
    bootingAt?: string;
    /** From bootingAt until both sides were ready, in ms; only when both booted. */
    bootMs?: number;
    /** `boot`: until main was ready; `apply`: how much longer this PR took. Set when both booted. */
    phaseMs?: { boot: number; apply: number };
    /** Each side's claim.ready.timing, when its cell reported one. */
    bootTiming?: Partial<Record<"base" | "pr", ClaimBootTiming>>;
    /** Each side's boot builds, step by step; a side whose cell sent nothing is missing, older Runs have none. */
    buildSteps?: RunBuildSteps[];
    /** The commands Kody ran on main's machine to look around before writing its probes. */
    exploration?: ExploredCommand[];
    /**
     * Why each entry point could not be cleared (run-report.ts UncoveredSchema).
     * Older Runs may omit these causes; the screen falls back to
     * `uncoveredEntryPoints` when they are absent.
     */
    uncovered?: RunUncovered[];
    /** What started the Run (libs/runtime/run RunTrigger). */
    trigger?: "pull_request" | "comment" | "run_again" | "simulate";
    /** What each reproducible probe sent and expected, by probeId: shape only, redacted (no body, query or input text). */
    probeRequests?: Record<string, ProbeRequest>;
    /**
     * Why a side did not boot. The backend may serve it as `bootFailure` or
     * `bootFailureDetail`; read both through model/boot-failure.ts.
     */
    bootFailure?: RunBootFailure;
    bootFailureDetail?: RunBootFailure;
    /** Every repository of a multi-repository environment and its commits on both sides (detail only); absent for one repository. */
    workspace?: RunWorkspaceRef[];
    /** Past the longest its state may last (the hang detector); absent within its bound. Nothing was stopped. */
    stuck?: RuntimeStuckState;
    /** How many of the PR's changed lines ran during the probes (run-report.ts `exercised`); older Runs have none. */
    exercised?: RunExercised;
};

/**
 * libs/runtime/run/run-report.ts `exercised` (docs/runtime/exercised-lines.md):
 * counts only, per changed file. `measured: false` means nothing was measured
 * (every file unknown, an unsupported language, or a cell without the feature).
 */
export type RunExercised = {
    summary: {
        exercised: number;
        changed: number;
        /** 0..1: below it a would-be no_regressions Run is partly_tested. */
        threshold: number;
        language?: "node" | "unsupported";
        measured: boolean;
        /** Not measured because the coverage mapped back to no source. */
        reason?: "no_source_map";
    };
    files: RunExercisedFile[];
};

export type RunExercisedFile = {
    path: string;
    changedLines: number;
    exercisedLines: number | null;
    status: "measured" | "unknown";
    reason?: string;
};

/** libs/runtime/api get-run.use-case.ts ProbeRequestView. */
export type ProbeRequest = ProbeRequestView;

/** libs/runtime/run/run-projection.ts RunBuildSteps. */
export type RunBuildSteps = LibRunBuildSteps;

/** libs/runtime/run/run-projection.ts ExploredCommand; its output is evidence at side `base`, this stepId. */
export type ExploredCommand = LibExploredCommand;

/** libs/runtime/run/run-report.ts UncoveredSchema. */
export type RunUncovered = Uncovered;

/** libs/runtime-publish/domain/run-publication-view.ts */
export type PublicationStatus = LibPublicationStatus;

export type PublicationKindView = LibPublicationKindView;

export type RunPublication = RunPublicationView;

/** libs/runtime/api/domain/run-cost.ts: every number is an estimate; null = could not be priced. */
export type RuntimeRunCost = {
    estimate: true;
    currency: "USD";
    llmTokens: number;
    machines: {
        minutes: number;
        vm: { instanceType: string; count: number; usdPerHour: number };
        observer: { instanceType: string; count: number; usdPerHour: number };
        region: string;
        usd: number | null;
        paidBy: "kodus" | "customer";
        /** shared_cell: by the host memory the claims held; vm: per VM for the wall time; absent on an older API (vm). */
        model?: "shared_cell" | "vm" | "unknown";
        /** shared_cell: MB × minutes held (build size, then ready size). */
        mbMinutes?: number;
        host?: {
            cellId: string;
            instanceType: string;
            usdPerHour: number;
            region: string;
        };
        /** shared_cell on the org's own cells: the price per host-hour the org set, which priced usd. */
        ownHostUsdPerHour?: number;
        /** Why usd is null although machines were held. */
        unpriced?: "missing_claim_facts" | "cell_price_unknown";
    };
    llm: {
        tokens: number;
        usd: number | null;
        models: Array<{
            model?: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            /** Tokens of calls priced at a tier above the base one (a prompt over the model's threshold). */
            aboveBaseTierTokens?: number;
            usd: number | null;
        }>;
        unsettledTokens: number;
        /** `telemetry`: the Run's usage spans; `not_measured`: the API cannot read them (usd is null). Absent on an older API. */
        source?: "telemetry" | "not_measured";
        agents?: Array<{
            agent: RuntimeLlmAgent;
            tokens: number;
            usd: number | null;
        }>;
        /** Of the priced US$, what the organization pays its own provider (BYOK). */
        customerUsd?: number;
    };
    totalUsd: number | null;
    complete: boolean;
};
// Older Runs and APIs omit some of these, so the web reads them as optional;
// every cost the API builds still has to fit the web's shape.
assertExact<Assignable<LibRuntimeRunCost, RuntimeRunCost>>(true);

/** Who spent the tokens (libs/runtime/api/domain/llm-spend.ts). */
export type RuntimeLlmAgent = LibRuntimeLlmAgent;

export type CellOwner = "kodus" | "customer";

export type FindingFeedbackValue = LibFindingFeedbackValue;

/** Who marked a finding intended and when; `mine` when it was the caller. */
export type FindingIntentMark = FindingIntentView;

/** What PUT …/findings/:probeId/intent answered. */
export type FindingIntentResult =
    ({ intended: true } & FindingIntentMark) | { intended: false };

export type FindingFeedback = FindingFeedbackView;

/** A row of GET /runtime/runs: the projection without the per-step detail. */
export type RuntimeRunSummary = Pick<
    RuntimeRun,
    | "runId"
    | "attempt"
    | "repositoryId"
    | "repositoryName"
    | "prNumber"
    | "headSha"
    | "state"
    | "requestedAt"
> &
    Partial<
        Pick<
            RuntimeRun,
            | "verdictState"
            | "phase"
            | "check"
            | "cellOwner"
            | "prTitle"
            | "startedAt"
            | "finishedAt"
            | "updatedAt"
            | "cost"
        >
    >;

/** Closed sets of the evidence key {orgId}/{runId}/{side}/{stepId}/{type}. */
export type EvidenceSide = "base" | "pr" | "setup";
export type EvidenceType =
    | "output"
    | "screenshot"
    | "video"
    | "trace"
    | "har"
    | "proxy_log"
    | "app_log"
    | EvidenceUploadType;

export const RUN_STREAM_EVENT_TYPES = [
    "state",
    "phase",
    "step.started",
    "step.finished",
    "verdict",
    "published",
] as const;

export type RunStreamEventType = (typeof RUN_STREAM_EVENT_TYPES)[number];

export type RunStreamEvent = {
    type: RunStreamEventType;
    at: string;
    data: Record<string, unknown>;
};

export type RunStreamPage = {
    events: RunStreamEvent[];
    /** Opaque; only ever sent back as `offset`. */
    nextOffset: string;
    upToDate: boolean;
};

// Environment, Blocker and Health follow docs §5 (EnvironmentHealth, Blocker,
// Fix) and libs/runtime/contracts/views/environments.ts.

export type BlockerKind = LibBlockerKind;

export type BlockerState =
    | "open"
    | "self_fixing"
    | "waiting_human"
    | "fix_applied"
    | "fixed"
    | "skipped";

export type EnvironmentImageState =
    "building" | "ready" | "failed" | "current" | "retired";

/**
 * The environment's state as the API merges it: the worker's setup record
 * once it answered the latest request, else the product row
 * (`setup_requested`, or `active` for a row never set up).
 */
export type EnvironmentState = RuntimeEnvironmentState;

/** One repository of an environment, as its Repositories section shows it. */
export type EnvironmentRepository = RuntimeEnvironmentRepositoryView;

/**
 * What a write on an environment's repositories answers
 * (libs/runtime/api environment-repositories.use-cases.ts): the repositories
 * as they are now, the one added or changed, and the setup it asked for.
 */
export type EnvironmentRepositoriesResult = {
    repositories: EnvironmentRepository[];
    /** Absent for a removal. */
    repository?: EnvironmentRepository;
    /** A setup was asked for: Runs keep the last good setup until it passes. */
    setupRequested: boolean;
    setupRequestedAt?: string;
};

export type RuntimeEnvironment = Omit<
    RuntimeEnvironmentView,
    "managed" | "metrics" | "egressApprovals" | "pool"
> & {
    /**
     * The product manages it (it has a product row): it can be set up and
     * configured. False for one only earlier Runs know, which every setup,
     * settings and repositories route answers 404 for. Absent (an older
     * API): managed.
     */
    managed?: boolean;
    /** Absent where the screen has no metrics yet. */
    metrics?: EnvironmentMetrics;
    egressApprovals?: EgressApproval[];
    pool?: EnvironmentPool;
};

/**
 * GET /runtime/environments/status (libs/runtime/api environment-view.ts
 * RuntimeEnvironmentStatusView): an environment's state and its setup's
 * times, without metrics or the setup record. Polled while a setup runs.
 */
export type RuntimeEnvironmentStatus = {
    environmentId: string;
    state?: RuntimeEnvironment["state"];
    setup?: {
        state: NonNullable<RuntimeEnvironment["setup"]>["state"];
        requestedAt: string;
        updatedAt: string;
        progress?: { updatedAt: string };
    };
    updatedAt?: string;
};

export type MachineSizePreset = LibMachineSizePreset;
export type ForkPullRequestPolicy = LibForkPullRequestPolicy;
export type MachineSize = LibMachineSize;

export type PoolWeekday = LibPoolWeekday;

/** When the machines are kept ready; null: all the time. */
export type PoolPolicy = LibPoolPolicy;

export type PoolReason = LibPoolReason;

export type EnvironmentPool = Omit<
    NonNullable<RuntimeEnvironmentView["pool"]>,
    "policy"
> & {
    policy?: PoolPolicy | null;
};

export type EnvironmentSetupStepName = LibEnvironmentSetupStepName;

export type EnvironmentSetupStepState = LibEnvironmentSetupStepState;

export type EnvironmentSetupStep = LibEnvironmentSetupStep;

/**
 * One part of a boot and how long it took (libs/runtime/protocol
 * BootPhasesSchema): "yarn install", "export layers", "pull image",
 * "compose up", "first healthy". `running`: the boot stopped in it.
 */
export type BootPhase = BootPhases[number];

/**
 * One time Kody rewrote its own recipe inside a setup, after the boot failed
 * on the recipe's account. `writing` / `booting`: still running; `booted` /
 * `blocked`: how the rewrite's boot ended; the others stopped the repairs
 * with no boot.
 */
export type EnvironmentSetupRepair = LibEnvironmentSetupRepair;

export type EnvironmentSetup = NonNullable<RuntimeEnvironmentView["setup"]>;

/** A typed fix Kody tried (S-23: a template label, never LLM text). */
export type EnvironmentLearnFix = NonNullable<EnvironmentLearnAttempt["fix"]>;

export type EnvironmentLearnAttempt = EnvironmentLearn["attempts"][number];

export type EnvironmentLearn = RuntimeLearnView;

export type SetupLastActive = EnvironmentLastActive;

export type SetupProgress = EnvironmentSetupProgress;

export type SetupFailureBundle = FailureBundle;

/** §11: environment.boot.success_rate, timings.bootMs, egress.blocked. */
export type EnvironmentMetrics = Partial<RuntimeEnvironmentView["metrics"]>;

/** claim.ready.timing: the cell's prepare time and the driver's boot phases, in ms. */
export type ClaimBootTiming = ClaimReadyTiming;

export type EgressBlockedHost = EgressBlockedRow;

/** How an approved host is reached (docs/runtime/egress-allowlist.md §6). */
export type EgressApprovalMode = NonNullable<EgressApprovalRow["mode"]>;

/** One approved outbound host of an environment or of the org list. */
export type EgressApproval = EgressApprovalRow;

export type EgressWhoMayAdd = "owners" | "owners_and_repo_admins" | "nobody";

/** GET /runtime/egress: the org's outbound access. */
export type OrgEgress = {
    settings: {
        recommendedEnabled: boolean;
        whoMayAdd: EgressWhoMayAdd;
        updatedBy?: string;
        updatedAt?: string;
    };
    recommended: {
        version: number;
        entries: Array<{
            host: string;
            ecosystem: string;
            tier: "mirror" | "inspected";
            paths: string[];
            why: string;
            doc: string;
        }>;
    };
    orgList: EgressApproval[];
    audit: Array<{
        action: "approve" | "revoke" | "settings";
        environmentId?: string;
        host?: string;
        mode?: string;
        actor: string;
        source: string;
        sourceRef?: string;
        recommendedVersion?: number;
        reason?: string;
        at: string;
    }>;
};

/**
 * A fix as a blocker card reads it: the catalog's (RuntimeBlockerFixView,
 * with its recipe diff and what Kody learned) or one about the environment's
 * repositories (MembershipBlockerFix), in one shape.
 */
export type BlockerFix = Omit<RuntimeBlockerFixView, "action"> &
    Partial<
        Pick<RuntimeMembershipFixView, "repositoryId" | "repository" | "alias">
    > & {
        action:
            | RuntimeBlockerFixView["action"]
            | RuntimeMembershipFixView["action"];
    };

/**
 * A fix about the environment's repositories, for what the committed
 * recipe's services.needs asks (libs/runtime/api environment-view.ts
 * RuntimeMembershipFixView): add a connected repository to the environment
 * (`needs_member:<repo>` cards), or connect it to Kodus first
 * (`needs_connection:<repo>` cards).
 */
export type MembershipBlockerFix = RuntimeMembershipFixView;

/** What Kody learned: the fix that got a blocker past, proven by a clean setup (ADR-018). */
export type RuntimeLesson = RuntimeLessonView;

export type BlockerEvidence = LibBlockerEvidence;

/** What POST /environments/:id/blockers/fixes did. */
/** POST /environments/:id/recipe/propose: the PR that adds the inferred recipe. */
export type ProposedRecipe = { pullRequest: { number: number; url: string } };

export type AppliedBlockerFix =
    | { action: "approve_host"; host: string; setupRequested: true }
    | { action: "retry_setup"; setupRequested: true }
    | {
          action:
              | "set_env"
              | "raise_health_timeout"
              | "set_health_path"
              | "set_public_service";
          pullRequest: { number: number; url: string };
      };

/** One row of GET /environments/:id/blockers: blockers grouped by signature. */
export type BlockerGroup = Omit<
    RuntimeBlockerGroupView,
    "kind" | "title" | "state" | "fixes"
> & {
    kind: BlockerKind;
    title?: string;
    state?: BlockerState;
    fixes?: BlockerFix[];
};

/** The raw Blocker of docs §5, in case the route returns them ungrouped. */
export type RuntimeBlocker = {
    id: string;
    environmentId: string;
    kind: BlockerKind;
    signature: string;
    title: string;
    state: BlockerState;
    fixes?: BlockerFix[];
    seen: { count: number; firstAt: string; lastAt: string; lastPr?: number };
};

export type RuntimeCell = {
    cellId: string;
    /** "Kodus cloud" for the managed fleet (one entry, `cellId: "kodus-cloud"`). */
    name?: string;
    owner: CellOwner;
    status: "connected" | "disconnected" | "revoked" | (string & {});
    region?: string;
    topology?: string;
    version?: string;
    lastHeartbeatAt?: string;
};

/** Where a customer cell runs: next to Kodus Cloud's control plane, or with Kodus self-hosted. */
export type CellTopology = LibCellTopology;

export type CellRegistrationToken = {
    /** The token's SHA-256: lists and revokes it, registers nothing. */
    id: string;
    token: string;
    topology: CellTopology;
    expiresAt: string;
};

export type CellRegistrationTokenState = CellTokenState;

/** GET /runtime/cells/registration-tokens (owner only): the org's tokens of the last 24 h, never the token. */
export type CellRegistrationTokenView = LibCellRegistrationTokenView;

export type RuntimeWhoCanAsk = LibRuntimeWhoCanAsk;

/** When the Runtime runs on a repo (screen 2). `auto` is shown as "Soon". */
export type RuntimeMode = LibRuntimeMode;

export type RuntimeRuleCondition = RuleCondition;

/** Every condition must hold; any rule that holds runs the PR. */
export type RuntimeTriggerRule = TriggerRule;

export type RuntimeRepositorySettings = {
    repositoryId: string;
    repositoryName?: string;
    /**
     * Derived by the API from `mode` (`mode !== "off"`). Read-only for the
     * UI: `mode` is the one switch it writes.
     */
    pilot?: boolean;
    whoCanAsk: RuntimeWhoCanAsk;
    mode?: RuntimeMode;
    rules?: RuntimeTriggerRule[];
    runOnAgentPullRequests?: boolean;
    runOnNewPushes?: boolean;
};

/** GET /runtime/settings/machine-minutes: the org's machine minutes of the current UTC day. */
export type RuntimeMachineMinutesToday = LibRuntimeMachineMinutesToday;
/** PATCH /runtime/settings/machine-minutes: the org's own daily limit as saved; the hub applies it from its next claim round. */
export type RuntimeMachineMinutesLimitChange = {
    minutesPerDay: number | null;
    changedAt: string;
};

export type RuntimeSettings = {
    /** Daily token budget per org, enforced at the LLM gateway (§11). */
    tokenBudgetPerDay?: number | null;
    /**
     * The org's own exercised-lines threshold, 0..100 (0: never changes the
     * verdict); null: the default below applies (docs/runtime/exercised-lines.md §7).
     */
    exercisedLinesThresholdPercent?: number | null;
    /** The deployment's threshold, what an org that set none gets. */
    exercisedLinesThresholdDefaultPercent?: number;
    /** US$ one hour of the org's own host costs; null: its own machines are not priced. Absent from an older API. */
    machineUsdPerHostHour?: number | null;
    repositories: RuntimeRepositorySettings[];
};
// The web also builds these as the body it sends, so they keep optional
// fields; what the API answers still has to fit them.
assertExact<
    Assignable<RuntimeRepositorySettingsView, RuntimeRepositorySettings>
>(true);
assertExact<Assignable<RuntimeSettingsView, RuntimeSettings>>(true);

/**
 * The tenant API only stops the caller's own organization; the global stop
 * is an on-call route (/internal/runtime/ops) the web never calls.
 */
export type RuntimeStopScope = "org";

/** GET /runtime/settings/usage (owner only): a month of Runtime usage (docs/runtime/usage-report.md). */
export type RuntimeUsageDurationStats = DurationStats;

export type RuntimeUsageMachine = MachineUsage;

export type RuntimeUsageLlmTotals = NonNullable<
    LibRuntimeUsageReport["llm"]["total"]
>;

export type RuntimeUsageRun = UsageReportRun;

export type RuntimeUsageReport = Omit<LibRuntimeUsageReport, "previews"> & {
    previews?: LibRuntimeUsageReport["previews"];
};

/** A Run or a setup past the hang detector's bound for its state. */
export type RuntimeStuckState = NonNullable<RuntimeRunDetail["stuck"]>;

/** A figure the API could not read on this deployment: why, never a zero. */
export type RuntimeNotMeasured = NotMeasured;
export type RuntimeMeasured<T> = Measured<T>;

/** One item past the longest its state may last (the hang detector's bound, docs/runtime/observability.md). */
export type RuntimeHealthStuck = LibRuntimeHealthStuck;

export type RuntimeHealthCell = HealthCell;

/** GET /runtime/settings/health (owner only): Kody Runtime → Settings → Health. */
export type RuntimeHealth = LibRuntimeHealth;
/** GET /runtime/settings/health/speed: p50/p95 of the org's Runs over 7 or 30 days. */
export type RuntimeSpeed = LibRuntimeSpeed;
export type {
    MachineHost,
    MachineSource,
    SpeedMetrics,
    SpeedStat,
    SpeedWindowDays,
};

/**
 * A Run preview as GET /runtime/previews/:id answers it (PreviewView in
 * libs/runtime/contracts/preview.ts, docs/runtime/preview-urls.md §5.2).
 */
export type PreviewSide = LibPreviewSide;
export type PreviewState = LibPreviewState;
export type RuntimePreview = Omit<
    PreviewView,
    "idleMinutes" | "ceilingMinutes"
> & {
    /** The idle stop and one start's ceiling it runs with (absent from an older API: 15 and 120). */
    idleMinutes?: number;
    ceilingMinutes?: number;
};

export type PreviewSecrets = LibPreviewSecrets;
export type PreviewForks = LibPreviewForks;

/** Whether a preview can open, and why not (PreviewOffer in libs/runtime/api previews.use-cases.ts). */
export interface RuntimePreviewOffer {
    available: boolean;
    reason?: string;
    code?: string;
    /** The PR side only: why it does not open while the base does (a fork's). */
    prReason?: string;
    idleMinutes: number;
    ceilingMinutes: number;
    secrets: PreviewSecrets;
}

/** GET /runtime/runs/:runId/previews */
export interface RuntimeRunPreviews {
    offer: RuntimePreviewOffer;
    sides: Partial<Record<PreviewSide, RuntimePreview>>;
}

/** GET /runtime/environments/:id/previews */
export interface RuntimeEnvironmentPreview {
    offer: RuntimePreviewOffer;
    sha?: string;
    preview?: RuntimePreview;
}

/** GET and PUT /runtime/settings/preview (owner). */
export type RuntimePreviewSettings = PreviewSettings;
export interface RuntimePreviewSettingsView {
    available: boolean;
    settings: RuntimePreviewSettings;
    usedMinutesThisMonth: number | null;
}

/** One row of the preview activity (GET /runtime/audit?kind=preview). */
export interface RuntimePreviewAuditRecord {
    at: string;
    previewId: string;
    runId?: string;
    side?: PreviewSide;
    actor?: string;
    action:
        | "session_opened"
        | "session_refused"
        | "session_closed"
        | "started"
        | "woken"
        | "slept"
        | "stopped"
        | "expired";
    reason?: string;
}

/** GET/PUT /sandbox-capacity (self-hosted owner): the cap, the live numbers and what is known of the cell. */
export interface SandboxCapacityView {
    settings: { maxConcurrent: number | null; maxWaitMs: number };
    saved: boolean;
    live: {
        inUse: number | null;
        cap: number;
        queued: number;
        oldestWaitMs: number;
    };
    suggestedMaxConcurrent: number | null;
    /** null when the hub does not expose the cell (see cellUnavailableReason). */
    cell: {
        allocatableMemoryMb: number | null;
        sandboxMemoryMb: number | null;
        sandboxCpus: number | null;
        poolReady: number | null;
        /** Absent from an API older than the field. */
        poolTarget?: number | null;
    } | null;
    cellUnavailableReason: string | null;
}
