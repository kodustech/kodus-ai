// The e2e suite as the product's /runtime routes answer it (docs/runtime/e2e-suites.md sections 10 and 13). Structured fields only: the
// web writes the sentences. Types only; every import here is `import type`.

/**
 * How the specs were chosen (the Runtime's `SuiteSelectionReport`, libs/runtime/suite/report.ts, built from the same stored JSON). It is
 * declared here, not imported: that file imports the selection rules, and a view reaches the web build as types only, with nothing of them.
 * `reason` is a `FullReason` of libs/runtime/suite/select.ts (a parity spec in the web holds the two lists to each other).
 */
export interface RuntimeSuiteSelectionView {
    /** `full`: the whole suite ran (with `reason`); `selected`: the specs the change can reach; `none`: nothing was reached. */
    mode: 'full' | 'selected' | 'none';
    reason?: string;
    selected?: number;
    total: number;
    /** Set while main is ahead of the merge base and no coverage map could say which specs the diff reaches: why. */
    reachUnknown?: string;
    /** For a `selected` run: per changed file, the specs it reaches (bounded); absent on a re-push. */
    reachedBy?: Record<string, string[]>;
}

/** `runtime_suite_runs.state`. */
export type RuntimeSuiteRunState = 'requested' | 'running' | 'passed' | 'failed' | 'neutral' | 'timed_out' | 'cancelled' | 'errored';

/**
 * Whose fault a red test is, as the page groups them: `regression` (fails on the PR and passes on main), `pre_existing` (fails on
 * main too), `flaky` (passed on the re-run) and `unclassified` (anything the re-runs could not settle). `detail` keeps the classifier's own class.
 */
export type RuntimeSuiteFailureGroup = 'regression' | 'pre_existing' | 'flaky' | 'unclassified';

export interface RuntimeSuiteArtifactView {
    name: string;
    contentType: string;
    bytes: number;
}

export interface RuntimeSuiteFailureView {
    spec: string;
    /** The test's full title; empty for a spec that never reported (a lost host). */
    title: string;
    group: RuntimeSuiteFailureGroup;
    /** The classifier's class (`regression_unconfirmed`, `failed_unconfirmed`, `infra`, `pre_existing_changed`, ...). */
    detail: string;
    /** Why a failure stayed unclassified: `infra`, `budget`, `mass_failure`, `timeout` or `not_run`. */
    reason?: string;
    /** The last failed attempt's error on the PR, redacted and cut by the Runtime; absent when the run did not keep one. */
    error?: string;
    /** The tries of the test on the PR: the runner's own retries of the first pass plus the re-run. */
    pr: { attempts: number; failed: number };
    /** What the re-run on main said; absent when main was not run for it. `sha` is the commit main was run at. */
    main?: { sha: string; outcome: 'passed' | 'failed' | 'not_run'; sameError: boolean };
    /** The changed files of the PR that reach this spec through the coverage map; empty when the run did not say. */
    reachedBy: string[];
    artifacts: RuntimeSuiteArtifactView[];
}

/** One spec of the first pass, as the specs table shows it. */
export interface RuntimeSuiteSpecView {
    spec: string;
    shard: number;
    /** The runner's verdict; `flaky` is a pass that needed one of the runner's own retries. */
    result: 'passed' | 'flaky' | 'failed' | 'skipped' | 'not_run' | 'infra';
    /** The classifier's group for a spec that failed (regression, pre-existing, flaky, unclassified). */
    group?: RuntimeSuiteFailureGroup;
    /** The runner's time for the spec; 0 when it did not report one. */
    durationMs: number;
    tests: Array<{ title: string; status: string; attempts: Array<'passed' | 'failed' | 'skipped'> }>;
    /** Names of the files kept for it (trace, video, screenshot). */
    artifacts: string[];
}

/** Where one host's time went, in instants; a field the run did not record is absent. */
export interface RuntimeSuiteHostTimeView {
    shard: number;
    /** `list` read main's spec files; `shard` ran specs; `rerun` re-ran failures (on the PR or on main). */
    role: 'list' | 'shard' | 'rerun';
    /** The fleet was asked for the host. */
    requestedAt?: string;
    /** The host's machine was up. */
    readyAt?: string;
    /** The app was up on it and the specs started. */
    startedAt?: string;
    /** The specs ended. */
    finishedAt?: string;
    /** The host was gone. */
    endedAt?: string;
}

export interface RuntimeSuiteShardView {
    shard: number;
    specs: number;
    passed: number;
    failed: number;
    notRun: number;
    /** The runner's own time over the shard's specs, summed (not wall time); null when none reported a duration. */
    specMs: number | null;
}

export interface RuntimeSuiteRunView {
    suiteRunId: string;
    environmentId: string;
    mode: 'run' | 'ci';
    state: RuntimeSuiteRunState;
    requestedAt: string;
    finishedAt?: string;
    /** From the request to the end. */
    durationMs?: number;
    prNumber?: number;
    prSha?: string;
    mainSha: string;
    mergeBase?: string;
    /** The baseline the failures were judged against (its main commit). */
    baselineSha?: string;
    /** Main commits ahead of the PR's merge base; absent when not known. */
    baseDrift?: number;
    /** How the specs were chosen: the whole suite with the reason, or the selection with the changed file to specs map. */
    selection: RuntimeSuiteSelectionView;
    /** Specs the first pass ran, and the suite's size. */
    specs: { ran: number; total: number };
    totals: { passed: number; failed: number; skipped: number; notRun: number };
    classes: { regression: number; preExisting: number; flaky: number; unclassified: number };
    /** The machine time the run's hosts were held, in ms summed over hosts; absent on a run that did not measure it. */
    machine?: { firstPassMs: number; rerunMs: number };
    /** Hosts the first pass used (one per shard that held specs). */
    hosts: number;
    shards: RuntimeSuiteShardView[];
    failures: RuntimeSuiteFailureView[];
    /** The specs that passed in the first pass, in order. */
    passed: string[];
    /** Every spec of the first pass, with its tests, tries and time. */
    specRows: RuntimeSuiteSpecView[];
    /** Each host's moments, in the order they were asked for. */
    hostTimes: RuntimeSuiteHostTimeView[];
    /** The caller may ask for the failed specs again: the run ended and left a red or unreported spec. */
    canRetry: boolean;
}

/** The environment's e2e suite for Settings (docs section 13): what the recipe says, what selection is doing, and the last baseline. */
export interface RuntimeEnvironmentSuiteView {
    environmentId: string;
    /** What `.kodus/workspace.yaml` declares at the environment's main commit; absent when it declares no suite (the section then explains how to add one). */
    recipe?: {
        runner: string;
        specs: string;
        command: string;
        cwd?: string;
        results?: string;
        /** The shard ceiling and the gate are the recipe's: shown here, edited in the file. */
        shards?: number;
        gate: 'default' | 'strict';
        baseline: boolean;
    };
    /** The newest complete baseline run on main. */
    lastBaseline?: { sha: string; specs: number; passed: number; failed: number; finishedAt: string };
    selection: {
        /** A person's switch (`suite selection`): false means every PR runs the whole suite. */
        enabled: boolean;
        /** The shadow check stopped selection: `off` until a person resumes it, or the whole suite for the next `fullPrsLeft` pull requests. */
        brake?: { off: boolean; fullPrsLeft: number; miss?: { prNumber: number; specs: string[] } };
    };
    /** Run on every push as a CI check: the environment's setting, else the deployment's default. */
    ci: { enabled: boolean; source: 'environment' | 'deployment' };
}

/** One line of the usage report's e2e suite table. */
export interface RuntimeSuiteUsageLine {
    kind: 'pr' | 'baseline' | 'rerun' | 'shadow';
    runs: number;
    /** Machine minutes the hosts were held; null when none of the line's runs measured it. */
    minutes: number | null;
}

export interface RuntimeSuiteUsage {
    lines: RuntimeSuiteUsageLine[];
    /** Runs of the month stored before machine time was measured: their minutes are not in the lines. */
    unmeasuredRuns: number;
    /**
     * What selection saved, measured and never extrapolated: over the selected PR runs a full shadow run also covered, the shadow's
     * first-pass minutes less the selected run's. Absent when no shadow of the month finished with both measured.
     */
    saved?: { minutes: number; shadowedRuns: number };
}
