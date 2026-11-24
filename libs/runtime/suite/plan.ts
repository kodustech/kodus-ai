import { planRepush, type PreviousSuiteRun } from './repush';
import { type CoverageMapInput, type FullReason, select, type SelectInput, type Selection } from './select';
import type { SuiteSelectionReport } from './report';

// The specs one suite run executes (docs/runtime/e2e-suites.md section 6.1), on the request path: a normal run selects from the
// change set, a re-push of the same PR (`previous`) runs what was red plus what the new commits reach, and the safety net
// returns the whole suite whenever an input is missing. Pure. `map` is the newest complete coverage map of
// the environment; absent (none recorded yet) every plan is the whole suite with the reason `map_missing`; nothing here skips a spec on a guess.

export interface SuitePlanInput {
    allSpecs: readonly string[];
    suiteDigest: string;
    mergeBase: string;
    prSha: string;
    /** `diff(mergeBase, prSha)`; absent: the product could not give it (unknown, never "nothing changed"). */
    changed?: readonly string[];
    /** `diff(previous.prSha, prSha)` for a re-push; absent: unknown. */
    deltaFiles?: readonly string[];
    /** The earlier run of this PR, for the re-push rule. */
    previous?: PreviousSuiteRun;
    /** The newest complete coverage map of the environment; absent while none was recorded. */
    map?: CoverageMapInput;
    ignore?: readonly string[];
    importersOf?: SelectInput['importersOf'];
    workspaceSpecsOf?: SelectInput['workspaceSpecsOf'];
    /** The whole suite regardless of the map and of an earlier run (a shadow run; the brake of the shadow check): the reason says which. */
    forceFull?: SelectInput['forceFull'];
}

export interface SuitePlan {
    /** In the order of `allSpecs`. */
    specs: string[];
    /** Red on the previous push: the risk-first order puts them first in their shard. */
    failedBefore: string[];
    /** Per selected spec, how many changed files reach it. */
    diffCoverage: Record<string, number>;
    selection: SuiteSelectionReport;
    text: string;
}

export function planSuiteRun(i: SuitePlanInput): SuitePlan {
    const all = [...i.allSpecs];
    const total = all.length;
    const full = (reason: FullReason, text: string): Selection => ({ mode: 'full', specs: all, reason, text });
    const selectOver = (changed: readonly string[] | undefined): Selection => {
        if (changed === undefined) return full(i.map ? 'changes_unknown' : 'map_missing', i.map ? 'the changed files are unknown' : 'no coverage map for this environment yet');
        const s = select({ allSpecs: all, changed, ...(i.map ? { map: i.map } : {}), suiteDigest: i.suiteDigest, ...(i.ignore ? { ignore: i.ignore } : {}), ...(i.importersOf ? { importersOf: i.importersOf } : {}), ...(i.workspaceSpecsOf ? { workspaceSpecsOf: i.workspaceSpecsOf } : {}) });
        // Without a map nothing proves a spec can be skipped, not even an ignored-only change: the whole suite.
        return !i.map && s.mode === 'selected' ? full('map_missing', 'no coverage map for this environment yet') : s;
    };

    if (i.forceFull) {
        const f = select({ allSpecs: all, changed: [], suiteDigest: i.suiteDigest, forceFull: i.forceFull });
        return { specs: all, failedBefore: i.previous ? (i.previous.failures.filter((x) => x.class !== 'pre_existing').map((x) => x.spec).filter((s) => all.includes(s))) : [], diffCoverage: {}, selection: { mode: 'full', ...(f.mode === 'full' ? { reason: f.reason } : {}), total }, text: f.text };
    }
    if (i.previous) {
        // A whole-suite re-push carries the reason of the selection that sent it there.
        let reason: FullReason | undefined;
        const seen = (s: Selection): Selection => {
            if (s.mode === 'full') reason = s.reason;
            return s;
        };
        const r = planRepush({ previous: i.previous, mergeBase: i.mergeBase, prSha: i.prSha, allSpecs: all, delta: () => seen(selectOver(i.deltaFiles)), fromMergeBase: () => seen(selectOver(i.changed)) });
        return {
            specs: r.specs,
            failedBefore: r.failedBefore,
            diffCoverage: r.diffCoverage,
            selection: r.mode === 'full' ? { mode: 'full', ...(reason ? { reason } : {}), total } : r.mode === 'none' ? { mode: 'none', total } : { mode: 'selected', selected: r.specs.length, total },
            text: r.text,
        };
    }
    const s = selectOver(i.changed);
    if (s.mode === 'full') return { specs: all, failedBefore: [], diffCoverage: {}, selection: { mode: 'full', reason: s.reason, total }, text: s.text };
    return { specs: s.specs, failedBefore: [], diffCoverage: s.diffCoverage, selection: s.specs.length ? { mode: 'selected', selected: s.specs.length, total } : { mode: 'none', total }, text: s.text };
}
