// The re-run classifier (docs/runtime/e2e-suites.md section 9): given what failed
// in the first pass on the PR and what the re-runs said, whose fault is each red
// test. Pure and table-driven: every branch is a row of 9.2 to 9.5. It never
// reads error text beyond comparing `errorSignature`s (the infra signals are the
// closed list the engine reports, never a guess from a message).

// ---- inputs -----------------------------------------------------------------

/** One failed test of the PR's first pass. */
export interface SuiteFailure {
    spec: string;
    title: string;
    /** `infra` only by the closed list of 9.2 (host lost, crash without result, browser crash, services unhealthy); else `test`. */
    kind: 'test' | 'infra';
    /** The spec timeout tripped. */
    timedOut: boolean;
    errorSignature: string;
}

/** What a re-run of one test said. */
export type Rerun =
    | { result: 'passed' }
    | { result: 'failed'; errorSignature: string; timedOut: boolean }
    | { result: 'infra' }
    /** Never ran: the re-run cap (`timeout.rerun`) tripped, or the host went away. */
    | { result: 'not_run' };

/** The baseline of the PR's merge base, as 7.1 stores it, with how fresh it is. */
export interface BaselineEvidence {
    sha: string;
    /** The baseline is of the PR's exact merge base. */
    exactMergeBase: boolean;
    /** Main commits since that sha. */
    commitsBehindMain: number;
    /** Its `suite_digest` equals the current one. */
    digestMatches: boolean;
    specs: Readonly<Record<string, { status: 'passed' | 'failed'; errorSignature?: string }>>;
}

export type MainSide =
    /** The re-run on a template host happened; a test with no entry did not finish. */
    | { state: 'ran'; results: Readonly<Record<string, Rerun>> }
    /** No ready template: main is not waited for (9.5). */
    | { state: 'template_missing' }
    /** No main host in 2 attempts (9.5). */
    | { state: 'no_host' };

export interface ClassifyInput {
    failures: readonly SuiteFailure[];
    plan: RerunPlan;
    /** The PR re-run per test (`testKey`). */
    prRerun: Readonly<Record<string, Rerun>>;
    /** The fresh-host retry of a first-pass infra failure, per test. */
    infraRerun: Readonly<Record<string, Rerun>>;
    main: MainSide;
    /** Main commits the template is ahead of the PR's merge base (8.2). */
    baseDrift: number;
    /** Specs the PR's diff reaches (entry points, the coverage map): a regression on main-ahead needs it. */
    diffReachedSpecs: readonly string[];
    baseline?: BaselineEvidence;
    /** Specs a shard never ran and that were still unfinished after one re-queue. */
    notRunSpecs: readonly string[];
}

// ---- the plan before the re-runs -------------------------------------------

/** Section 9.4. */
export const RERUN_BUDGET = 40;
export const MASS_FAILURE_RATIO = 0.25;
/** Section 9.5: a baseline older than this many main commits is history, not evidence. */
export const BASELINE_MAX_COMMITS_BEHIND = 20;

export const testKey = (spec: string, title: string) => `${spec}\u0000${title}`;

export interface RerunPlan {
    /** More than 25% of the specs failed: nothing is re-run, everything is unclassified. */
    massFailure: boolean;
    /** Specs to re-run on the PR and on main (one entry per spec, at most 40). */
    rerunSpecs: string[];
    overBudgetSpecs: string[];
    /** Specs with an infra failure: one retry on a fresh host, outside the rules. */
    infraRetrySpecs: string[];
}

/**
 * `failingOnMain`: the specs a usable baseline records as failed on main. They are main's failures, not this PR's, so
 * they do not count toward a mass failure (they are still re-run and classified, pre_existing by the baseline).
 */
export function planReruns(i: { specsRun: number; failures: readonly SuiteFailure[]; budget?: number; failingOnMain?: ReadonlySet<string> }): RerunPlan {
    const failedSpecs = new Set(i.failures.map((f) => f.spec).filter((s) => !i.failingOnMain?.has(s)));
    if (i.specsRun > 0 && failedSpecs.size / i.specsRun > MASS_FAILURE_RATIO) {
        return { massFailure: true, rerunSpecs: [], overBudgetSpecs: [], infraRetrySpecs: [] };
    }
    const infra = new Set(i.failures.filter((f) => f.kind === 'infra').map((f) => f.spec));
    const wanted = [...new Set(i.failures.filter((f) => f.kind === 'test' && !infra.has(f.spec)).map((f) => f.spec))];
    const budget = i.budget ?? RERUN_BUDGET;
    return { massFailure: false, rerunSpecs: wanted.slice(0, budget), overBudgetSpecs: wanted.slice(budget), infraRetrySpecs: [...infra] };
}

/**
 * 8.2: a test that failed in the exact merge base's baseline with the same
 * signature as its PR re-run is red everywhere; it needs no main re-run.
 */
export function needsMainRerun(f: SuiteFailure, prRerun: Rerun, baseline: BaselineEvidence | undefined): boolean {
    if (prRerun.result !== 'failed' || !usable(baseline)) return true;
    const b = baseline.specs[f.spec];
    return !(b?.status === 'failed' && b.errorSignature !== undefined && b.errorSignature === f.errorSignature && b.errorSignature === prRerun.errorSignature);
}

// ---- outputs ----------------------------------------------------------------

export type FailureClass =
    | 'flaky'
    | 'regression'
    /** Main passed but is ahead of the merge base and the diff does not reach the spec (D2). */
    | 'regression_unconfirmed'
    /** No main host; the exact baseline passed the spec (9.5). */
    | 'regression_probable'
    | 'pre_existing'
    | 'pre_existing_changed'
    | 'failed_unconfirmed'
    | 'infra'
    | 'unclassified';

export type UnclassifiedReason = 'infra' | 'budget' | 'mass_failure' | 'timeout' | 'not_run';

export interface ClassifiedTest {
    spec: string;
    title: string;
    class: FailureClass;
    reason?: UnclassifiedReason;
    /** Only a `regression` blocks. */
    blocks: boolean;
    /** Only a `regression` becomes a Kody finding. */
    finding: boolean;
    prSignature?: string;
    mainSignature?: string;
    baseDrift: number;
}

export interface Classification {
    tests: ClassifiedTest[];
    massFailure: boolean;
    /** The main re-run could not be had because there is no template: ask for a build for the next run. */
    requestTemplateBuild: boolean;
}

// ---- the rules ---------------------------------------------------------------

function usable(b: BaselineEvidence | undefined): b is BaselineEvidence {
    return !!b && b.exactMergeBase && b.digestMatches && b.commitsBehindMain <= BASELINE_MAX_COMMITS_BEHIND;
}

export function classifyFailures(i: ClassifyInput): Classification {
    const over = new Set(i.plan.overBudgetSpecs);
    const reached = new Set(i.diffReachedSpecs);

    const make = (f: { spec: string; title: string }, cls: FailureClass, extra: Partial<ClassifiedTest> = {}): ClassifiedTest => ({
        spec: f.spec,
        title: f.title,
        class: cls,
        blocks: cls === 'regression',
        finding: cls === 'regression',
        baseDrift: i.baseDrift,
        ...extra,
    });
    const unclassified = (f: { spec: string; title: string }, reason: UnclassifiedReason): ClassifiedTest => make(f, 'unclassified', { reason });

    // 9.5 when main's re-run cannot decide: the exact, fresh baseline, else nothing.
    const fromBaseline = (f: SuiteFailure, pr: string): ClassifiedTest => {
        const b = usable(i.baseline) ? i.baseline.specs[f.spec] : undefined;
        if (!b) return make(f, 'failed_unconfirmed', { prSignature: pr });
        if (b.status === 'failed') return make(f, 'pre_existing', { prSignature: pr, ...(b.errorSignature ? { mainSignature: b.errorSignature } : {}) });
        return make(f, 'regression_probable', { prSignature: pr });
    };

    let requestTemplateBuild = false;
    const tests: ClassifiedTest[] = i.failures.map((f) => {
        const key = testKey(f.spec, f.title);
        if (i.plan.massFailure) return unclassified(f, 'mass_failure');

        if (f.kind === 'infra') {
            const retry = i.infraRerun[key];
            if (retry?.result === 'passed') return make(f, 'infra');
            return unclassified(f, retry?.result === 'not_run' ? 'timeout' : 'infra');
        }

        if (over.has(f.spec)) return unclassified(f, 'budget');

        const pr = i.prRerun[key] ?? { result: 'not_run' as const };
        if (pr.result === 'passed') return make(f, 'flaky');
        if (pr.result === 'not_run') return unclassified(f, 'timeout');
        if (pr.result === 'infra') return unclassified(f, 'infra');

        if (i.main.state === 'template_missing') {
            requestTemplateBuild = true;
            return make(f, 'failed_unconfirmed', { prSignature: pr.errorSignature });
        }
        const main: Rerun = i.main.state === 'ran' ? (i.main.results[key] ?? { result: 'infra' }) : { result: 'infra' };
        if (main.result === 'not_run') return unclassified(f, 'timeout');
        if (main.result === 'infra') return fromBaseline(f, pr.errorSignature);
        if (main.result === 'passed') {
            if (i.baseDrift > 0 && !reached.has(f.spec)) return make(f, 'regression_unconfirmed', { prSignature: pr.errorSignature });
            return make(f, 'regression', { prSignature: pr.errorSignature });
        }
        const sides = { prSignature: pr.errorSignature, mainSignature: main.errorSignature };
        if (pr.timedOut && main.timedOut) return make(f, 'pre_existing', sides);
        return make(f, pr.errorSignature === main.errorSignature ? 'pre_existing' : 'pre_existing_changed', sides);
    });

    for (const spec of i.notRunSpecs) tests.push(unclassified({ spec, title: '' }, 'not_run'));
    return { tests, massFailure: i.plan.massFailure, requestTemplateBuild };
}
