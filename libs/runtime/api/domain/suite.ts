import type { Classification, SuiteSelectionReport } from '@libs/runtime/suite';

// What the product reads of the e2e suite's tables (docs/runtime/e2e-suites.md section 7): plain records as the Runtime stored them,
// and the port the use cases read them through. The Runtime owns the tables; the product only reads, with the read-only role.

export type StoredSuiteState = 'requested' | 'running' | 'passed' | 'failed' | 'neutral' | 'timed_out' | 'cancelled' | 'errored';
export type StoredSuiteMode = 'run' | 'ci' | 'baseline' | 'shadow';
export type StoredSuitePhase = 'shard' | 'rerun_pr' | 'rerun_main';

export interface StoredSuiteRunRecord {
    suiteRunId: string;
    organizationId: string;
    environmentId: string;
    repositoryId: string;
    mode: StoredSuiteMode;
    state: StoredSuiteState;
    prNumber?: number;
    prSha?: string;
    mergeBase?: string;
    mainSha: string;
    selection?: SuiteSelectionReport;
    classification?: Classification;
    baselineSha?: string;
    baseDrift?: number;
    firstPassMs?: number;
    rerunMs?: number;
    requestedAt: string;
    finishedAt?: string;
}

export interface StoredSuiteShardRecord {
    shard: number;
    specs: string[];
    /** When the shard's claim was ready and when its specs ended (absent on runs from before they were recorded). */
    startedAt?: string;
    finishedAt?: string;
}

/** A host the fleet started for one shard of the run (`runtime_hosts`, bound `suite:<org>/<run>/<shard>`): when it was asked for, ready and gone. */
export interface StoredSuiteHost {
    shard: number;
    requestedAt: string;
    readyAt?: string;
    endedAt?: string;
}

export interface StoredSuiteTest {
    title: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    attempts: Array<{ status: 'passed' | 'failed' | 'skipped'; ms: number; error?: string }>;
}

export interface StoredSuiteResultRecord {
    phase: StoredSuitePhase;
    shard: number;
    spec: string;
    status: string;
    durationMs: number;
    errorSignature?: string;
    tests: StoredSuiteTest[];
    artifacts: Array<{ name: string; key: string; contentType: string; bytes: number }>;
}

export interface StoredSuiteRun {
    run: StoredSuiteRunRecord;
    shards: StoredSuiteShardRecord[];
    results: StoredSuiteResultRecord[];
    /** Absent where no fleet started the hosts (a static cell) or the hosts cannot be read. */
    hosts?: StoredSuiteHost[];
}

/** An environment's selection state (`runtime_suite_selection_state`): who turned it off and the whole-suite window a miss left. */
export interface StoredSelectionState {
    off: boolean;
    offBy?: 'brake' | 'person';
    fullPrsLeft: number;
    reenabledAt?: string;
}

/** The newest baseline request of an environment: what became of the baseline its latest main commit asked for. */
export interface StoredBaselineRequest {
    sha: string;
    state: 'queued' | 'started' | 'skipped' | 'superseded';
    /** Why it ended without a run (`no_suite`, `superseded`); absent while queued or started. */
    reason?: string;
}

export interface StoredBaselineSummary {
    sha: string;
    specs: number;
    passed: number;
    failed: number;
    finishedAt: string;
}

/** What the shadow check found: the newest done shadow whose full run failed a spec the selection had skipped. */
export interface StoredSelectionMiss {
    prNumber: number;
    specs: string[];
}

export interface StoredSuiteUsageRow {
    mode: StoredSuiteMode;
    runs: number;
    firstPassMs: number;
    rerunMs: number;
    /** Runs that ran a re-run (rerun_ms over zero). */
    withRerun: number;
    /** Runs that never measured machine time (stored before it was). */
    unmeasured: number;
}

export interface StoredSuiteSavings {
    shadowedRuns: number;
    /** Sum over the pairs of the shadow's first-pass ms less the selected run's. */
    savedMs: number;
}

/** Reads the suite tables of the Runtime Postgres; every read names the organization. */
export interface RuntimeSuiteReader {
    /** A suite run with its plan and its stored results; null for an id the organization does not hold. */
    get(organizationId: string, suiteRunId: string): Promise<StoredSuiteRun | null>;
    /**
     * A suite run of the same environment and PR asked for after `after` that has not ended (a re-run of it, or a newer run),
     * within the last `withinMs`: a row a crashed worker never finished does not block forever.
     */
    liveRunAfter(organizationId: string, environmentId: string, prNumber: number, after: string, withinMs: number): Promise<boolean>;
    selectionState(organizationId: string, environmentId: string): Promise<StoredSelectionState>;
    lastBaseline(organizationId: string, environmentId: string): Promise<StoredBaselineSummary | null>;
    /** The environment's newest baseline request, or null when no template of it ever asked for one. */
    lastBaselineRequest(organizationId: string, environmentId: string): Promise<StoredBaselineRequest | null>;
    /** The newest miss since selection was last turned on (`since`, when given). */
    lastMiss(organizationId: string, environmentId: string, since?: string): Promise<StoredSelectionMiss | null>;
    usageOfMonth(organizationId: string, window: { start: Date; end: Date }): Promise<{ rows: StoredSuiteUsageRow[]; savings: StoredSuiteSavings | null }>;
}

export const RUNTIME_SUITE_READER = Symbol.for('RuntimeApi.SuiteReader');
