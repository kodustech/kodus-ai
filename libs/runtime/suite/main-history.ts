import { MAP_MAX_AGE_MS } from './select';

// What main says about a spec, and when a full run on main is worth its hosts (docs/runtime/e2e-suites.md section 7.2, "lazy
// baseline"). Pure: the store (`PgSuiteMainResults`) and the suite service apply it.

/** The most recent runs of a spec on main the history looks at. */
export const MAIN_HISTORY_RUNS = 20;
/** Default cadence of a full run on main: even when nothing else asks for one, selection and flake history are refreshed this often. */
export const BASELINE_CADENCE_DEFAULT_MS = 24 * 3_600_000;

// ---- one spec's history on main --------------------------------------------

/** One run of a spec on main: a baseline, or the main re-run of a PR's failed spec. */
export interface MainObservation {
    mainSha: string;
    status: 'passed' | 'failed';
    errorSignature?: string;
    /** Epoch ms. */
    observedAt: number;
}

export interface MainSpecHistory {
    /** The runs counted (the last `MAIN_HISTORY_RUNS`). */
    runs: number;
    passed: number;
    failed: number;
    /** Different outcomes on the same main commit: the industry rule for a flaky test. */
    flaky: boolean;
    /** The signatures its failures on main had: a PR failure with one of them is a failure main has too. */
    failureSignatures: string[];
}

/** Pass, fail and flaky over the newest `MAIN_HISTORY_RUNS` observations of one spec. */
export function mainSpecHistory(observations: readonly MainObservation[], last: number = MAIN_HISTORY_RUNS): MainSpecHistory {
    const recent = [...observations].sort((a, b) => b.observedAt - a.observedAt).slice(0, last);
    const bySha = new Map<string, Set<string>>();
    for (const o of recent) bySha.set(o.mainSha, (bySha.get(o.mainSha) ?? new Set()).add(o.status));
    return {
        runs: recent.length,
        passed: recent.filter((o) => o.status === 'passed').length,
        failed: recent.filter((o) => o.status === 'failed').length,
        flaky: [...bySha.values()].some((s) => s.size > 1),
        failureSignatures: [...new Set(recent.filter((o) => o.status === 'failed' && o.errorSignature).map((o) => o.errorSignature as string))],
    };
}

/**
 * What the runs of a spec at one main commit say as a result a PR can reuse: `passed` or `failed` when every run agrees, `mixed`
 * when the same commit gave both (the spec is flaky there, so no single run is evidence), `none` without a run.
 */
export function mainOutcomeAt(observations: ReadonlyArray<Pick<MainObservation, 'status'>>): 'passed' | 'failed' | 'mixed' | 'none' {
    if (observations.length === 0) return 'none';
    const passed = observations.some((o) => o.status === 'passed');
    const failed = observations.some((o) => o.status === 'failed');
    return passed && failed ? 'mixed' : failed ? 'failed' : 'passed';
}

// ---- when main runs the whole suite ------------------------------------------

export type BaselineDueReason = 'first' | 'digest_changed' | 'map_missing' | 'map_digest' | 'map_stale' | 'cadence';

export interface BaselineDueInput {
    /** Epoch ms. */
    now: number;
    /** The digest of the suite at the main commit asked for. */
    suiteDigest: string;
    /** The bound on how long main goes without a full run (`RUNTIME_SUITE_BASELINE_CADENCE_HOURS`). */
    cadenceMs: number;
    /** The newest complete baseline of the environment. */
    baseline?: { suiteDigest: string; finishedAt: number };
    /** Whether a coverage map is kept at all (selection is on): a map then needs to stay fresh too. */
    keepsMap: boolean;
    /** The newest complete coverage map of the environment. */
    map?: { suiteDigest: string; finishedAt: number };
}

/**
 * Whether a main commit needs a full baseline: only when the suite changed under the stored one (digest), when the coverage map
 * selection reads is missing, of another suite or past its age (D12), or when the cadence is over. Otherwise main runs
 * only the specs a PR failed, and a baseline would add nothing a PR run could not get when it needs it.
 */
export function baselineDue(i: BaselineDueInput): { due: true; reason: BaselineDueReason } | { due: false; reason: 'lazy' } {
    if (!i.baseline) return { due: true, reason: 'first' };
    if (i.baseline.suiteDigest !== i.suiteDigest) return { due: true, reason: 'digest_changed' };
    if (i.keepsMap) {
        if (!i.map) return { due: true, reason: 'map_missing' };
        if (i.map.suiteDigest !== i.suiteDigest) return { due: true, reason: 'map_digest' };
        if (i.now - i.map.finishedAt > MAP_MAX_AGE_MS) return { due: true, reason: 'map_stale' };
    }
    if (i.now - i.baseline.finishedAt >= i.cadenceMs) return { due: true, reason: 'cadence' };
    return { due: false, reason: 'lazy' };
}
