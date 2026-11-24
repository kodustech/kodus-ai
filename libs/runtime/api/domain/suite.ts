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
}

/** An environment's selection state (`runtime_suite_selection_state`): who turned it off and the whole-suite window a miss left. */
export interface StoredSelectionState {
    off: boolean;
    offBy?: 'brake' | 'person';
    fullPrsLeft: number;
    reenabledAt?: string;
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
    selectionState(organizationId: string, environmentId: string): Promise<StoredSelectionState>;
    lastBaseline(organizationId: string, environmentId: string): Promise<StoredBaselineSummary | null>;
    /** The newest miss since selection was last turned on (`since`, when given). */
    lastMiss(organizationId: string, environmentId: string, since?: string): Promise<StoredSelectionMiss | null>;
    usageOfMonth(organizationId: string, window: { start: Date; end: Date }): Promise<{ rows: StoredSuiteUsageRow[]; savings: StoredSuiteSavings | null }>;
}

export const RUNTIME_SUITE_READER = Symbol.for('RuntimeApi.SuiteReader');
