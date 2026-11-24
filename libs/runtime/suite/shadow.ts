// The shadow check of selection (docs/runtime/e2e-suites.md section 6.1 "Proof (b)" and D14): in production a selected run is
// sometimes also run in full in the background, and what the full run finds that the selection skipped is a selection miss. These
// are the rules, pure: which runs get a shadow, what counts as a miss, and what the brake does.

/** D14: `S` is 5 for the first 50 selected runs of an environment, then 10. */
export const SHADOW_EARLY_RUNS = 50;
export const SHADOW_EVERY_EARLY = 5;
export const SHADOW_EVERY = 10;
/** D14: one miss means the whole suite for the next `M` pull requests. */
export const FULL_AFTER_MISS_PRS = 10;
/** D14: this many misses among the last `BRAKE_WINDOW_SHADOWS` shadows turn selection off until a person re-enables it. */
export const BRAKE_MISSES = 2;
export const BRAKE_WINDOW_SHADOWS = 10;

/** Whether the `selectedRuns`-th selected run of the environment (1-based, counted when it was planned) also runs in full in the background. */
export function shadowDue(selectedRuns: number): boolean {
    if (!Number.isInteger(selectedRuns) || selectedRuns < 1) return false;
    return selectedRuns % (selectedRuns <= SHADOW_EARLY_RUNS ? SHADOW_EVERY_EARLY : SHADOW_EVERY) === 0;
}

/**
 * The specs the selection skipped that the full run proved broken: a `regression` (failed on the PR twice, passed on main) in a spec the
 * selected run did not run, or one still `regression_unconfirmed` (the same, but main had moved ahead of the merge base, which makes
 * every regression unconfirmed: the brake errs toward the whole suite). Flaky, pre-existing and otherwise unclassified failures are noise,
 * never a miss. No classification (the shadow did not finish) is no evidence of a miss.
 */
export function missesOf(i: { selected: readonly string[]; classification?: { tests: ReadonlyArray<{ spec: string; class: string }> } }): string[] {
    const ran = new Set(i.selected);
    const out = new Set<string>();
    for (const t of i.classification?.tests ?? []) if ((t.class === 'regression' || t.class === 'regression_unconfirmed') && !ran.has(t.spec)) out.add(t.spec);
    return [...out].sort();
}

/** What a shadow's misses do, given how many misses the environment has among its last ten shadows (this one included). */
export function brakeAfterMiss(i: { missesInWindow: number }): { fullPrs: number; off: boolean } {
    return { fullPrs: FULL_AFTER_MISS_PRS, off: i.missesInWindow >= BRAKE_MISSES };
}
