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
    /**
     * `diff(lastGreenMain, prSha)` when the merge base has no coverage map (`diffBaseFor`): what selection reads instead of `changed`,
     * so what main changed since the map is in it. `diffReach` keeps `changed`: it asks what the pull request itself reaches.
     */
    selectionChanged?: readonly string[];
    /** `diff(previous.prSha, prSha)` for a re-push; absent: unknown. */
    deltaFiles?: readonly string[];
    /** The earlier run of this PR, for the re-push rule. */
    previous?: PreviousSuiteRun;
    /** The newest complete coverage map of the environment; absent while none was recorded. */
    map?: CoverageMapInput;
    ignore?: readonly string[];
    importersOf?: SelectInput['importersOf'];
    workspaceSpecsOf?: SelectInput['workspaceSpecsOf'];
    /**
     * The guards of `select`: never skip a spec with no recorded pass on main, `suite.unskippable`, `suite.full_run_files`. They decide
     * what runs, not what the diff reaches, so `diffReach` reads only the last one: a diff too wide to narrow reaches everything.
     */
    passedOnMain?: SelectInput['passedOnMain'];
    unskippable?: SelectInput['unskippable'];
    fullRunFiles?: SelectInput['fullRunFiles'];
    /** The whole suite regardless of the map and of an earlier run (a shadow run; the brake of the shadow check): the reason says which. */
    forceFull?: SelectInput['forceFull'];
    /** The suite directory (relative to the repository root): `changed` is the repository's, the specs are the suite's. */
    cwd?: string;
}

/** Why the reach of the diff is not known: the reasons of `select` that say nothing about which specs a change touches. */
export type ReachUnknownReason = Extract<FullReason, 'map_missing' | 'map_stale' | 'map_digest' | 'changes_unknown' | 'uncovered_file' | 'noise_file'>;

/**
 * The specs the PR's diff reaches, which the classifier asks while main is ahead of the merge base (section 9.3). `unknown` is
 * set when no usable coverage map (or nothing in the map) can say; `specs` then holds only what the PR changed itself.
 */
export interface DiffReach {
    specs: string[];
    unknown?: ReachUnknownReason;
}

const guardsOf = (i: SuitePlanInput): Pick<SelectInput, 'passedOnMain' | 'unskippable' | 'fullRunFiles'> => ({
    ...(i.passedOnMain ? { passedOnMain: i.passedOnMain } : {}),
    ...(i.unskippable ? { unskippable: i.unskippable } : {}),
    ...(i.fullRunFiles !== undefined ? { fullRunFiles: i.fullRunFiles } : {}),
});

/** Whole-suite reasons that mean everything may be affected: the file alone says it, whatever the map holds. */
const EVERYTHING: ReadonlySet<FullReason> = new Set<FullReason>(['manifest', 'lockfile', 'config', 'shared_routing', 'huge_diff']);

export interface SuitePlan {
    /** In the order of `allSpecs`. */
    specs: string[];
    /** Red on the previous push: the risk-first order puts them first in their shard. */
    failedBefore: string[];
    /** Per selected spec, how many changed files reach it. */
    diffCoverage: Record<string, number>;
    selection: SuiteSelectionReport;
    text: string;
    /** What the whole diff (merge base to PR sha) reaches; absent for a shadow run, which judges no diff. */
    reach?: DiffReach;
}

/** Same map, same freshness and digest rules, same importer walk and workspace closure as `select`, over the whole diff; pure. */
export function diffReach(i: SuitePlanInput): DiffReach {
    const all = [...i.allSpecs];
    const changed = new Set(i.changed ?? []);
    // A spec the PR added or modified is always reached.
    const own = all.filter((s) => changed.has(s) || (i.cwd !== undefined && changed.has(`${i.cwd.replace(/\/$/, '')}/${s}`)));
    if (i.changed === undefined) return { specs: own, unknown: i.map ? 'changes_unknown' : 'map_missing' };
    const s = select({ allSpecs: all, changed: i.changed, ...(i.map ? { map: i.map } : {}), suiteDigest: i.suiteDigest, ...(i.ignore ? { ignore: i.ignore } : {}), ...(i.importersOf ? { importersOf: i.importersOf } : {}), ...(i.workspaceSpecsOf ? { workspaceSpecsOf: i.workspaceSpecsOf } : {}), ...(i.fullRunFiles !== undefined ? { fullRunFiles: i.fullRunFiles } : {}) });
    if (s.mode === 'full') return EVERYTHING.has(s.reason) ? { specs: all } : { specs: own, unknown: s.reason as ReachUnknownReason };
    // Without a map nothing proves what the change reaches, not even an ignored-only one.
    if (!i.map) return { specs: own, unknown: 'map_missing' };
    const reached = new Set([...s.specs, ...own]);
    return { specs: all.filter((x) => reached.has(x)) };
}

export function planSuiteRun(i: SuitePlanInput): SuitePlan {
    const plan = planSpecs(i);
    return i.forceFull === 'shadow' ? plan : { ...plan, reach: diffReach(i) };
}

function planSpecs(i: SuitePlanInput): SuitePlan {
    const all = [...i.allSpecs];
    const total = all.length;
    const full = (reason: FullReason, text: string): Selection => ({ mode: 'full', specs: all, reason, text });
    const selectOver = (changed: readonly string[] | undefined): Selection => {
        if (changed === undefined) return full(i.map ? 'changes_unknown' : 'map_missing', i.map ? 'the changed files are unknown' : 'no coverage map for this environment yet');
        const s = select({ allSpecs: all, changed, ...(i.map ? { map: i.map } : {}), suiteDigest: i.suiteDigest, ...(i.ignore ? { ignore: i.ignore } : {}), ...(i.importersOf ? { importersOf: i.importersOf } : {}), ...(i.workspaceSpecsOf ? { workspaceSpecsOf: i.workspaceSpecsOf } : {}), ...guardsOf(i) });
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
        const r = planRepush({ previous: i.previous, mergeBase: i.mergeBase, prSha: i.prSha, allSpecs: all, delta: () => seen(selectOver(i.deltaFiles)), fromMergeBase: () => seen(selectOver(i.selectionChanged ?? i.changed)) });
        return {
            specs: r.specs,
            failedBefore: r.failedBefore,
            diffCoverage: r.diffCoverage,
            selection: r.mode === 'full' ? { mode: 'full', ...(reason ? { reason } : {}), total } : r.mode === 'none' ? { mode: 'none', total } : { mode: 'selected', selected: r.specs.length, total },
            text: r.text,
        };
    }
    const s = selectOver(i.selectionChanged ?? i.changed);
    if (s.mode === 'full') return { specs: all, failedBefore: [], diffCoverage: {}, selection: { mode: 'full', reason: s.reason, total }, text: s.text };
    return { specs: s.specs, failedBefore: [], diffCoverage: s.diffCoverage, selection: s.specs.length ? { mode: 'selected', selected: s.specs.length, total, reachedBy: s.reachedBy } : { mode: 'none', total }, text: s.text };
}
