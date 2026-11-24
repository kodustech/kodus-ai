import type { Classification, ClassifiedTest } from './classifier';
import type { FullReason } from './select';
import type { TestResult } from './types';

// What the suite's check says (docs/runtime/e2e-suites.md section 10.1), as structured fields: the product renders them,
// the Runtime never writes the sentence. Pure: the run's stored state, its first-pass results and the classification in.

/** `runtime_suite_runs.state`. */
export const SUITE_REPORT_STATES = ['requested', 'running', 'passed', 'failed', 'neutral', 'timed_out', 'cancelled', 'errored'] as const;
export type SuiteReportState = (typeof SUITE_REPORT_STATES)[number];

/** Why a run ended before it ran anything. */
export const SUITE_UNAVAILABLE_REASONS = ['template_missing', 'no_host', 'list_failed', 'no_repository', 'no_specs'] as const;
export type SuiteUnavailableReason = (typeof SUITE_UNAVAILABLE_REASONS)[number];

export type SuiteCheckConclusion = 'success' | 'failure' | 'neutral' | 'timed_out' | 'cancelled';

/** GitHub takes at most this many annotations in one request; more go in follow-up updates of the same check run. */
export const ANNOTATION_PAGE = 50;
/** What one check keeps: the rest is counted, and the check says how many it does not show. */
export const ANNOTATIONS_MAX = 200;
export const ANNOTATION_MESSAGE_MAX = 400;
export const ANNOTATION_TITLE_MAX = 255;

/** D4: a regression fails the run, flaky and pre-existing never do, unclassified is neutral (failed with the strict gate, which the run's state already holds). */
export function suiteConclusionOf(state: SuiteReportState): SuiteCheckConclusion {
    switch (state) {
        case 'passed':
            return 'success';
        case 'failed':
            return 'failure';
        case 'timed_out':
            return 'timed_out';
        case 'cancelled':
            return 'cancelled';
        default:
            return 'neutral';
    }
}

/** The failing line of a test: the line of the spec in the error's stack, when the stack names the spec. */
export function failingLineOf(error: string | undefined, spec: string): number | undefined {
    if (!error) return undefined;
    const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|[\\s(/])${escaped}:(\\d{1,7})(?::\\d+)?`).exec(error);
    return m ? Number(m[1]) : undefined;
}

export interface SuiteAnnotation {
    path: string;
    line: number;
    level: 'failure' | 'warning';
    title: string;
    message: string;
}

export interface SuiteSelectionReport {
    /** `full`: the whole suite ran (with `reason`); `selected`: the specs the change can reach; `none`: nothing was reached. */
    mode: 'full' | 'selected' | 'none';
    reason?: FullReason;
    selected?: number;
    total: number;
    /** Set while main is ahead of the merge base and no coverage map could say which specs the diff reaches: why, so the check can. */
    reachUnknown?: FullReason;
    /** For a `selected` run: per changed file, the specs it reaches (bounded, `REACHED_BY_LIMITS`); absent on a re-push, which selects over the new commits and what was red before. */
    reachedBy?: Record<string, string[]>;
}

export interface SuiteReport {
    state: SuiteReportState;
    mode: 'run' | 'ci';
    mainSha: string;
    prSha?: string;
    baseline?: { sha: string };
    /** Main commits ahead of the PR's merge base (8.2). */
    baseDrift?: number;
    selection: SuiteSelectionReport;
    /** Specs by what the first pass ended as; `notRun` holds the infra and the not run. */
    totals: { passed: number; failed: number; skipped: number; notRun: number };
    /** Red tests by class (9.3): `unclassified` holds every class that is not confirmed. */
    classes: { regression: number; preExisting: number; flaky: number; unclassified: number; infra: number };
    durationMs?: number;
    annotations: SuiteAnnotation[];
    annotationsOmitted: number;
    unavailable?: SuiteUnavailableReason;
    requestedAt: string;
}

export interface SuiteReportInput {
    run: { state: SuiteReportState; mode: 'run' | 'ci'; mainSha: string; prSha?: string; mergeBase?: string; requestedAt: string; finishedAt?: string };
    /** The suite directory: an annotation's path is the repository's. */
    cwd?: string;
    /** The run's stored result rows; the first pass (`shard`) is what the totals and the annotations read. */
    results: ReadonlyArray<{ phase: string; spec: string; status: string; tests: unknown[] }>;
    classification?: Classification;
    selection: SuiteSelectionReport;
    baseline?: { sha: string };
    baseDrift?: number;
    unavailable?: SuiteUnavailableReason;
}

const CONFIRMED_NOT: ReadonlySet<ClassifiedTest['class']> = new Set(['unclassified', 'failed_unconfirmed', 'regression_unconfirmed', 'regression_probable']);

const lastError = (tests: unknown[], title: string): string | undefined => {
    const t = (tests as TestResult[]).find((x) => x?.title === title && x.status === 'failed');
    return [...(t?.attempts ?? [])].reverse().find((a) => a.status === 'failed')?.error;
};

export function buildSuiteReport(i: SuiteReportInput): SuiteReport {
    const first = new Map(i.results.filter((r) => r.phase === 'shard').map((r) => [r.spec, r]));
    const totals = { passed: 0, failed: 0, skipped: 0, notRun: 0 };
    for (const r of first.values()) {
        if (r.status === 'passed') totals.passed++;
        else if (r.status === 'failed') totals.failed++;
        else if (r.status === 'skipped') totals.skipped++;
        else totals.notRun++;
    }
    const tests = i.classification?.tests ?? [];
    const classes = { regression: 0, preExisting: 0, flaky: 0, unclassified: 0, infra: 0 };
    for (const t of tests) {
        if (t.class === 'regression') classes.regression++;
        else if (t.class === 'pre_existing' || t.class === 'pre_existing_changed') classes.preExisting++;
        else if (t.class === 'flaky') classes.flaky++;
        else if (t.class === 'infra') classes.infra++;
        else if (CONFIRMED_NOT.has(t.class)) classes.unclassified++;
    }
    // Regressions first: they are what the author must read, and what survives the cap.
    const annotated = [...tests.filter((t) => t.class === 'regression'), ...tests.filter((t) => t.class !== 'regression' && CONFIRMED_NOT.has(t.class) && t.title !== '')];
    const all = annotated.map((t): SuiteAnnotation => {
        const error = lastError(first.get(t.spec)?.tests ?? [], t.title);
        return {
            path: i.cwd ? `${i.cwd.replace(/\/$/, '')}/${t.spec}` : t.spec,
            line: failingLineOf(error, t.spec) ?? 1,
            level: t.class === 'regression' ? 'failure' : 'warning',
            title: t.title.slice(0, ANNOTATION_TITLE_MAX),
            message: (error ?? '').slice(0, ANNOTATION_MESSAGE_MAX),
        };
    });
    const finished = i.run.finishedAt ? Date.parse(i.run.finishedAt) - Date.parse(i.run.requestedAt) : undefined;
    return {
        state: i.run.state,
        mode: i.run.mode,
        mainSha: i.run.mainSha,
        ...(i.run.prSha ? { prSha: i.run.prSha } : {}),
        ...(i.baseline ? { baseline: i.baseline } : {}),
        ...(i.baseDrift !== undefined ? { baseDrift: i.baseDrift } : {}),
        selection: i.selection,
        totals,
        classes,
        ...(finished !== undefined && Number.isFinite(finished) && finished >= 0 ? { durationMs: finished } : {}),
        annotations: all.slice(0, ANNOTATIONS_MAX),
        annotationsOmitted: Math.max(0, all.length - ANNOTATIONS_MAX),
        ...(i.unavailable ? { unavailable: i.unavailable } : {}),
        requestedAt: i.run.requestedAt,
    };
}

/** The annotations in the requests GitHub accepts: at most `size` each, and always one page, so the check closes even with none. */
export function pageAnnotations<T>(items: readonly T[], size = ANNOTATION_PAGE): T[][] {
    if (items.length === 0) return [[]];
    const pages: T[][] = [];
    for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
    return pages;
}
