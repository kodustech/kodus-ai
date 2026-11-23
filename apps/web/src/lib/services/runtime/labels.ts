import type {
    BlockerKind,
    BlockerState,
    CellOwner,
    CheckConclusion,
    EnvironmentImageState,
    EnvironmentSetupStepName,
    EnvironmentSetupStepState,
    RunState,
    RuntimeMode,
    RuntimeWhoCanAsk,
    Verdict,
} from "./contracts";

// Every enum the Runtime screens print, mapped to its words and tone. The
// words follow the check titles of docs §3, so the dashboard and the PR say
// the same thing. Nothing here formats numbers (format.ts) or derives state
// from several fields (model/*).

export type Tone =
    "success" | "danger" | "warning" | "alert" | "info" | "neutral";

type Meta = { label: string; tone: Tone };

const RUN_STATE_META: Record<RunState, Meta & { terminal: boolean }> = {
    queued: { label: "Queued", tone: "info", terminal: false },
    awaiting_approval: {
        label: "Waiting for a maintainer",
        tone: "alert",
        terminal: false,
    },
    booting: { label: "Booting", tone: "info", terminal: false },
    testing: { label: "Testing", tone: "info", terminal: false },
    no_regressions: {
        label: "No regressions",
        tone: "success",
        terminal: true,
    },
    regression: { label: "Regression", tone: "danger", terminal: true },
    partly_tested: { label: "Partly tested", tone: "alert", terminal: true },
    nothing_to_test: {
        label: "Nothing to test",
        tone: "neutral",
        terminal: true,
    },
    could_not_boot: {
        label: "Could not boot",
        tone: "warning",
        terminal: true,
    },
    skipped: { label: "Skipped", tone: "neutral", terminal: true },
    superseded: { label: "Superseded", tone: "neutral", terminal: true },
    cancelled: { label: "Cancelled", tone: "neutral", terminal: true },
    timed_out: { label: "Timed out", tone: "warning", terminal: true },
    errored: { label: "Could not finish", tone: "warning", terminal: true },
    halted: {
        label: "Halted · security event",
        tone: "danger",
        terminal: true,
    },
};

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(
    (Object.keys(RUN_STATE_META) as RunState[]).filter(
        (s) => RUN_STATE_META[s].terminal,
    ),
);

const lookup = <K extends string, V>(
    table: Record<K, V>,
    key: string,
): V | undefined =>
    Object.prototype.hasOwnProperty.call(table, key)
        ? table[key as K]
        : undefined;

export const isRunState = (value: unknown): value is RunState =>
    typeof value === "string" && lookup(RUN_STATE_META, value) !== undefined;

export const isTerminalRunState = (state: RunState | string) =>
    lookup(RUN_STATE_META, state)?.terminal === true;

export const runStateLabel = (state: RunState | string): string =>
    lookup(RUN_STATE_META, state)?.label ?? String(state);

/**
 * The state chip of one Run's verdict card. "Partly tested" with no path
 * tested contradicts its own headline, so that case says what happened.
 */
export const verdictChipLabel = (
    state: RunState | string,
    testedCount: number,
): string =>
    state === "partly_tested" && testedCount === 0
        ? "Nothing tested"
        : runStateLabel(state);

export const runStateTone = (state: RunState | string): Tone =>
    lookup(RUN_STATE_META, state)?.tone ?? "neutral";

/**
 * Whether the check the API returns is the Run's own. The API fills `check`
 * from the state table for every Run, so a live one would read "neutral ·
 * testing"; only terminal Runs and a Run waiting for approval have a real one.
 */
export const isCheckFinal = (state: RunState) =>
    isTerminalRunState(state) || state === "awaiting_approval";

/** "Run again" opens a new attempt; the API only accepts it once the Run ended. */
export const canRunAgain = (state: RunState) => isTerminalRunState(state);

/** A fork Run waits for a maintainer (POST /runtime/runs/:id/approvals). */
export const canApprove = (state: RunState) => state === "awaiting_approval";

const CHECK_META: Record<CheckConclusion, Meta> = {
    success: { label: "Success", tone: "success" },
    failure: { label: "Failure", tone: "danger" },
    neutral: { label: "Neutral", tone: "neutral" },
    skipped: { label: "Skipped", tone: "neutral" },
    action_required: { label: "Action required", tone: "alert" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    timed_out: { label: "Timed out", tone: "warning" },
};

export const checkConclusionLabel = (c: CheckConclusion | string) =>
    lookup(CHECK_META, c)?.label ?? String(c);

export const checkConclusionTone = (c: CheckConclusion | string): Tone =>
    lookup(CHECK_META, c)?.tone ?? "neutral";

const VERDICT_META: Record<Verdict, Meta> = {
    finding: { label: "Finding", tone: "danger" },
    // Main and the PR answer the same, but not what Kody expected: the PR did
    // not cause it. "Already on main" read as "merged already" and "Fails on
    // main too" as a bug on main next to two 200s, so the label says both.
    pre_existing: {
        label: "Same on both versions, not as expected",
        tone: "neutral",
    },
    not_reproduced: { label: "Same on both versions", tone: "success" },
    inconclusive: { label: "Inconclusive", tone: "alert" },
    blocker: { label: "Blocked", tone: "warning" },
    unverified: { label: "Unverified", tone: "neutral" },
    // A route this PR adds that main does not have: new behavior, not a regression.
    new_endpoint: { label: "New endpoint", tone: "neutral" },
    // The intent oracle (docs/runtime/intent-oracle.md). Labels only: the screens for it wait on the owner's choice.
    described_change: { label: "Described change", tone: "neutral" },
    intent_mismatch: { label: "Not what the PR describes", tone: "alert" },
};

export const verdictLabel = (v: Verdict | string) =>
    lookup(VERDICT_META, v)?.label ?? String(v);

export const verdictTone = (v: Verdict | string): Tone =>
    lookup(VERDICT_META, v)?.tone ?? "neutral";

/** One tested path of a Run (screen 8), from its probe verdict. */
export type RunPathOutcome =
    | "regression"
    | "new_endpoint_error"
    | "intended"
    | "could_not_test"
    | "new_endpoint"
    | "pre_existing"
    | "same";

/** A path that fails the check: a regression against main, or an error on a route this PR adds. */
export const isFailingOutcome = (o: RunPathOutcome) =>
    o === "regression" || o === "new_endpoint_error";

export const RUN_PATH_OUTCOME_META: Record<RunPathOutcome, Meta> = {
    regression: { label: "Regression", tone: "danger" },
    new_endpoint_error: { label: "Error on a new endpoint", tone: "danger" },
    new_endpoint: { label: "New endpoint, not on main", tone: "neutral" },
    intended: { label: "Changed, as the PR intends", tone: "neutral" },
    could_not_test: { label: "Not tested", tone: "warning" },
    pre_existing: {
        label: "Same on both versions, not as expected",
        tone: "neutral",
    },
    same: { label: "Same on both versions", tone: "success" },
};

/** Regressions first, then what needs a look, then what held. */
export const RUN_PATH_OUTCOME_ORDER: Record<RunPathOutcome, number> = {
    regression: 0,
    new_endpoint_error: 1,
    intended: 2,
    could_not_test: 3,
    new_endpoint: 4,
    pre_existing: 5,
    same: 6,
};

const BLOCKER_KIND_LABEL: Record<
    | BlockerKind
    | "no_recipe"
    | "recipe_invalid"
    | "not_ready"
    | "cell_unavailable",
    string
> = {
    missing_env: "Missing variable",
    external_service: "External service",
    toolchain: "Toolchain",
    native_dep: "Native dependency",
    resources: "Machine resources",
    seed_data: "Seed data",
    other_repo: "Another repository",
    platform: "Platform",
    recipe_outdated: "Setup file out of date",
    unknown: "Unknown",
    security_violation: "Security violation",
    capacity: "No suitable machine",
    // Setup blockers the worker records next to the kinds of docs §5.
    no_recipe: "No setup file",
    recipe_invalid: "Invalid setup file",
    not_ready: "Not ready",
    cell_unavailable: "No machine",
};

export const blockerKindLabel = (kind: BlockerKind | string) =>
    lookup(BLOCKER_KIND_LABEL, kind) ?? String(kind);

const BLOCKER_STATE_META: Record<BlockerState, Meta> = {
    open: { label: "Open", tone: "warning" },
    self_fixing: { label: "Kody is fixing", tone: "info" },
    waiting_human: { label: "Needs you", tone: "alert" },
    fix_applied: { label: "Fix applied", tone: "info" },
    fixed: { label: "Fixed", tone: "success" },
    skipped: { label: "Skipped", tone: "neutral" },
};

export const blockerStateLabel = (s: BlockerState | string) =>
    lookup(BLOCKER_STATE_META, s)?.label ?? String(s);

export const blockerStateTone = (s: BlockerState | string): Tone =>
    lookup(BLOCKER_STATE_META, s)?.tone ?? "neutral";

const IMAGE_STATE_TONE: Record<EnvironmentImageState, Tone> = {
    building: "info",
    ready: "success",
    current: "success",
    failed: "danger",
    retired: "neutral",
};

export const imageStateTone = (s: EnvironmentImageState | string): Tone =>
    lookup(IMAGE_STATE_TONE, s) ?? "neutral";

const CELL_STATUS_META: Record<"connected" | "disconnected" | "revoked", Meta> =
    {
        connected: { label: "Connected", tone: "success" },
        disconnected: { label: "Disconnected", tone: "warning" },
        revoked: { label: "Revoked", tone: "danger" },
    };

export const cellStatusLabel = (status: string) =>
    lookup(CELL_STATUS_META, status)?.label ?? status;

export const cellStatusTone = (status: string): Tone =>
    lookup(CELL_STATUS_META, status)?.tone ?? "warning";

/** Where the machines of a Run or an environment run. */
export const cellOwnerLabel = (owner: CellOwner | undefined) =>
    owner === "customer" ? "Your own host" : "Kodus cloud";

const SETUP_STEP_LABEL: Record<EnvironmentSetupStepName, string> = {
    requested: "Requested",
    resolve_ref: "Pick the commit",
    recipe: "Read the setup file",
    boot: "Boot on a machine",
    ready: "Ready check",
    bake: "Bake the image",
    pool: "Keep machines ready",
    release: "Release the machine",
};

// The cell's phases inside the boot step (claim.progress).
const BOOT_PHASE_LABEL: Record<string, string> = {
    network: "Machine network",
    machines: "Machines",
    fetch: "Download the code",
    upload: "Upload the code",
    compose: "Build and start",
    egress: "Outbound access rules",
};

export const bootPhaseLabel = (phase: string) =>
    lookup(BOOT_PHASE_LABEL, phase) ?? phase.replace(/_/g, " ");

export const setupStepLabel = (name: EnvironmentSetupStepName | string) =>
    lookup(SETUP_STEP_LABEL, name) ?? String(name);

const SETUP_STEP_STATE_META: Record<EnvironmentSetupStepState, Meta> = {
    running: { label: "Running", tone: "info" },
    done: { label: "Done", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    skipped: { label: "Skipped", tone: "neutral" },
};

export const setupStepStateLabel = (s: EnvironmentSetupStepState | string) =>
    lookup(SETUP_STEP_STATE_META, s)?.label ?? String(s);

export const setupStepStateTone = (
    s: EnvironmentSetupStepState | string,
): Tone => lookup(SETUP_STEP_STATE_META, s)?.tone ?? "neutral";

export const WHO_CAN_ASK_OPTIONS: ReadonlyArray<{
    value: RuntimeWhoCanAsk;
    label: string;
}> = [
    { value: "maintainers", label: "Maintainers and admins" },
    { value: "writers", label: "Anyone with write access" },
    { value: "anyone_in_org", label: "Any member of the organization" },
];

export const RUNTIME_MODE_OPTIONS: ReadonlyArray<{
    value: RuntimeMode;
    label: string;
    hint: string;
}> = [
    { value: "off", label: "Off", hint: "Never runs." },
    {
        value: "on_request",
        label: "On request",
        hint: "When someone comments @kody runtime.",
    },
    {
        value: "rules",
        label: "Rules",
        hint: "When the PR matches a rule below.",
    },
];

export const runtimeModeLabel = (mode: RuntimeMode | string) =>
    RUNTIME_MODE_OPTIONS.find((m) => m.value === mode)?.label ?? String(mode);
