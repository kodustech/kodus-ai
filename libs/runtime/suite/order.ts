import type { BalancedPlan } from './balance';

// Risk-first order and fail fast (docs/runtime/e2e-suites.md section 6.1). The
// balance decides which shard a spec goes to; this only orders inside a shard,
// so the specs most likely to be red run first, and stops the first pass early
// when the first batch says the build or environment is broken.

export interface OrderContext {
    /** Specs red on the previous push (after classification, minus pre_existing). */
    failedBefore: readonly string[];
    /** Per spec, how many changed files it covers (`Selection.diffCoverage`). */
    diffCoverage: Readonly<Record<string, number>>;
    /** Estimated milliseconds per spec; a spec with none sorts as the shortest. */
    durations: Readonly<Record<string, number>>;
}

/**
 * failedBefore first, then the specs that cover the diff (more changed files
 * first), then the rest by duration, longest first. Within a group: coverage,
 * then duration, then path. Returns exactly the specs it was given.
 */
export function orderBin(specs: readonly string[], ctx: OrderContext): string[] {
    const failed = new Set(ctx.failedBefore);
    const cover = (s: string) => ctx.diffCoverage[s] ?? 0;
    const dur = (s: string) => ctx.durations[s] ?? 0;
    const group = (s: string) => (failed.has(s) ? 0 : cover(s) > 0 ? 1 : 2);
    return [...specs].sort((a, b) => group(a) - group(b) || (group(a) < 2 ? cover(b) - cover(a) : 0) || dur(b) - dur(a) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The bins of a balanced plan, each ordered; which spec is in which bin is not touched. */
export function orderBins(plan: BalancedPlan, ctx: OrderContext): string[][] {
    return plan.bins.map((b) => orderBin(b.specs, ctx));
}

/** The first batch of a run: at least 5 specs, 10% of the suite, never more than the suite. */
export const FAIL_FAST_MIN_BATCH = 5;
export const FAIL_FAST_BATCH_SHARE = 0.1;
export const FAIL_FAST_RATIO = 0.25;

export interface FailFastInput {
    allSpecs: readonly string[];
    /** Finished specs in the order they finished, across shards. */
    finished: ReadonlyArray<{ spec: string; failed: boolean }>;
}

export interface FailFastDecision {
    stop: boolean;
    /** The specs that never ran when the first pass stopped; empty when it goes on. */
    notRun: string[];
}

/**
 * When more than 25% of the first batch failed, stop the first pass and mark
 * the remaining specs `not_run`: the classifier then sees a mass failure
 * (`planReruns` with `specsRun` = the finished count) instead of paying the
 * full wall time. Decided as soon as the failures already exceed the share of
 * the whole batch, since later results cannot lower it.
 */
export function failFast(i: FailFastInput): FailFastDecision {
    const total = i.allSpecs.length;
    const batch = Math.min(total, Math.max(FAIL_FAST_MIN_BATCH, Math.ceil(total * FAIL_FAST_BATCH_SHARE)));
    if (batch === 0) return { stop: false, notRun: [] };
    const failed = i.finished.slice(0, batch).filter((r) => r.failed).length;
    if (failed / batch <= FAIL_FAST_RATIO) return { stop: false, notRun: [] };
    const done = new Set(i.finished.map((r) => r.spec));
    return { stop: true, notRun: i.allSpecs.filter((s) => !done.has(s)) };
}
