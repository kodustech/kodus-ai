import type { FailureClass } from './classifier';
import type { Selection } from './select';

// Re-push mode (docs/runtime/e2e-suites.md section 6.1): a new push on the same
// PR runs what was red before plus what the new delta reaches, instead of
// selecting again from the merge base. Pure: the caller computes the two
// selections it may need (lazily, so an unused one costs nothing).

export interface PreviousSuiteRun {
    prSha: string;
    mergeBase: string;
    /** Whether the whole suite ran, or a selection. */
    mode: 'full' | 'selected';
    green: boolean;
    /** What was red after classification, one entry per failing spec. */
    failures: ReadonlyArray<{ spec: string; class: FailureClass }>;
}

export interface RepushInput {
    previous: PreviousSuiteRun;
    /** The PR's merge base now: a rebase changes it. */
    mergeBase: string;
    prSha: string;
    allSpecs: readonly string[];
    /** `select` over `diff(previous.prSha, prSha)`. */
    delta: () => Selection;
    /** `select` over `diff(mergeBase, prSha)`: a normal selection, used after a rebase. */
    fromMergeBase: () => Selection;
}

export interface RepushPlan {
    /** `none`: no spec runs, and `text` says why. */
    mode: 'selected' | 'full' | 'none';
    /** In the order of `allSpecs`. */
    specs: string[];
    /** The earlier failures run again: the risk-first order puts them first. */
    failedBefore: string[];
    diffCoverage: Record<string, number>;
    text: string;
}

/** An earlier failure that proves nothing about this push's change is not forced in. */
const NOT_FORCED_IN: ReadonlySet<FailureClass> = new Set<FailureClass>(['pre_existing', 'pre_existing_changed']);

const fromSelection = (s: Selection, allSpecs: readonly string[], suffix = ''): RepushPlan => {
    if (s.mode === 'full') return { mode: 'full', specs: [...allSpecs], failedBefore: [], diffCoverage: {}, text: s.text + suffix };
    return { mode: s.specs.length ? 'selected' : 'none', specs: s.specs, failedBefore: [], diffCoverage: s.diffCoverage, text: s.text + suffix };
};

export function planRepush(i: RepushInput): RepushPlan {
    // A rebase: the delta from the old head means nothing; select again from the new merge base.
    if (i.previous.mergeBase !== i.mergeBase) return fromSelection(i.fromMergeBase(), i.allSpecs, ' (merge base changed)');

    const delta = i.delta();
    // A delta in the safety net escalates to the whole suite.
    if (delta.mode === 'full') return fromSelection(delta, i.allSpecs);

    const present = new Set(i.allSpecs);
    const failedBefore = new Set(i.previous.failures.filter((f) => !NOT_FORCED_IN.has(f.class) && present.has(f.spec)).map((f) => f.spec));
    const run = new Set([...failedBefore, ...delta.specs]);
    const specs = i.allSpecs.filter((s) => run.has(s));
    if (specs.length > 0) {
        return { mode: 'selected', specs, failedBefore: i.allSpecs.filter((s) => failedBefore.has(s)), diffCoverage: delta.diffCoverage, text: `${specs.length} of ${i.allSpecs.length} specs: ${failedBefore.size} red before, ${delta.specs.length} reached by the new commits` };
    }
    const last = i.previous.mode === 'full' ? 'last full run' : 'last run';
    const text = i.previous.failures.length > 0 ? 'no spec covers this change; the earlier failures are pre-existing' : `no spec covers this change; ${last} green (sha ${i.previous.prSha})`;
    return { mode: 'none', specs: [], failedBefore: [], diffCoverage: {}, text };
}
