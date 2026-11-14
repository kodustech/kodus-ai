import type { BlockerKind, CheckConclusion as SharedCheckConclusion, FindingIntent, FindingKind, Verdict } from '@libs/runtime/contracts/enums';

import type { ReplayLanes } from './replay-lanes';
import type { ResponseDiff } from './response-diff';

// Run lifecycle (docs §3). Every transition is one DBOS step in the
// runtime-worker; the Mongo projection is written by the same step.

export const RUN_STATES = [
    'queued',
    'skipped',
    'awaiting_approval',
    'booting',
    'testing',
    'no_regressions',
    'regression',
    'partly_tested',
    'could_not_boot',
    'superseded',
    'cancelled',
    'timed_out',
    'errored',
    'halted',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/** The computed verdict, kept next to `state`. It decides the check even when the Run is halted. */
export type VerdictState = 'no_regressions' | 'regression' | 'partly_tested' | 'could_not_boot';

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
    'no_regressions',
    'regression',
    'partly_tested',
    'could_not_boot',
    'skipped',
    'superseded',
    'cancelled',
    'timed_out',
    'errored',
    'halted',
]);

const TRANSITIONS: Record<RunState, RunState[]> = {
    // partly_tested straight from the queue: a PR that changes only the recipe the Run replaces boots nothing (S-19).
    queued: ['skipped', 'awaiting_approval', 'booting', 'partly_tested', 'timed_out', 'superseded', 'cancelled'],
    awaiting_approval: ['queued', 'cancelled', 'superseded', 'timed_out'],
    booting: ['could_not_boot', 'regression', 'partly_tested', 'testing', 'errored', 'superseded', 'cancelled', 'timed_out', 'halted'],
    testing: [
        'no_regressions',
        'regression',
        'partly_tested',
        'errored',
        'superseded',
        'cancelled',
        'timed_out',
        'halted',
    ],
    no_regressions: [],
    regression: [],
    partly_tested: [],
    could_not_boot: [],
    skipped: [],
    superseded: [],
    cancelled: [],
    timed_out: [],
    errored: [],
    halted: [],
};

export const isTerminal = (s: RunState) => TERMINAL_STATES.has(s);

export function canTransition(from: RunState, to: RunState): boolean {
    return TRANSITIONS[from].includes(to);
}

export class InvalidRunTransitionError extends Error {
    constructor(
        readonly from: RunState,
        readonly to: RunState,
    ) {
        super(`invalid Run transition ${from} -> ${to}`);
    }
}

export function assertTransition(from: RunState, to: RunState): void {
    if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
}

export type CheckConclusion = SharedCheckConclusion;

/** Verdict of one probe, with the entry point it covers (ADR-044 coverage). */
export interface ProbeVerdict {
    probeId: string;
    entryPoint: string;
    /**
     * What the probe sent, from its typed spec (`GET /api/health`), redacted.
     * Shown only: when `entryPoint` is 'unmapped' it names the route outside the
     * diff's entry points and covers none of them (S-32).
     */
    exercised?: string;
    /** The changed file with no route of its own that the agent says `entryPoint` reaches (its mapping, not coverage). */
    via?: string;
    verdict: Verdict;
    findingKind?: FindingKind;
    /** Set by the intent classifier; intended findings never lead to success. */
    intent?: FindingIntent;
    reason: string;
    differingFields?: string[];
    /** Observer steps of each side, for the evidence links. */
    baseStepIds?: string[];
    prStepIds?: string[];
    /**
     * A blocker verdict's structured cause: its kind and, for missing_env, the
     * variable name (never a value). The report and the Run page say "Needs NAME".
     */
    blocker?: { kind: BlockerKind; name?: string };
    /** Product id of the review suggestion this probe reproduces; the product resolves its comment. */
    suggestionId?: string;
    /**
     * Main and the PR on one clock for one healthy round each (request →
     * logs → database → outbound → response), with the first difference
     * (replay-lanes.ts). Shown only: no verdict reads it. Absent: no round
     * of a side answered.
     */
    lanes?: ReplayLanes;
    /**
     * What the two sides answered, field by field, on the first healthy round
     * of each (response-diff.ts): values JSON-stringified, redacted, cut to 200
     * characters. Shown on the Run page only: never in the PR comment, and no
     * verdict reads it.
     */
    responseDiff?: ResponseDiff;
    /**
     * The changed file this probe's entry point comes from (its `via`, or the
     * file the extractor matched) and the first added line of that file's
     * patch: where the Run page links the finding to the diff.
     */
    diffRef?: { file: string; line?: number };
}

export interface VerdictInput {
    /** Every entry point of the diff, measured or not. */
    entryPoints: string[];
    probes: ProbeVerdict[];
    /** The proxy denied an outbound request during the test (forces neutral). */
    blockedOutbound?: number;
    /** The diff changes lockfile, Dockerfile, compose, CI or vendored code without a behavior probe (S-34). */
    dependencyChangeUntested?: boolean;
    /** The product could not hand the whole diff (file or size cap): what was cut is untested. */
    diffTruncated?: boolean;
}

export interface VerdictOutcome {
    verdictState: Exclude<VerdictState, 'could_not_boot'>;
    findings: ProbeVerdict[];
    intendedFindings: ProbeVerdict[];
    uncoveredEntryPoints: string[];
    forcedNeutral: string[];
}

const DECIDED_WITHOUT_FINDING: ReadonlySet<Verdict> = new Set<Verdict>(['not_reproduced', 'pre_existing']);

/**
 * The verdict table of §3: regression > partly_tested > no_regressions.
 * success needs not_reproduced on every entry point of the diff. A
 * pre_existing probe does not satisfy that requirement or invalidate another
 * not_reproduced probe. No probe on that entry point may be undecided: an
 * inconclusive, blocker or unverified probe keeps its entry point uncovered
 * even when another probe settled it.
 */
export function decideRunVerdict(input: VerdictInput): VerdictOutcome {
    const findings = input.probes.filter((p) => p.verdict === 'finding');
    const unintended = findings.filter((p) => p.intent !== 'intended');
    const intended = findings.filter((p) => p.intent === 'intended');

    const settled = new Set(input.probes.filter((p) => p.verdict === 'not_reproduced').map((p) => p.entryPoint));
    const undecided = new Set(input.probes.filter((p) => p.verdict !== 'finding' && !DECIDED_WITHOUT_FINDING.has(p.verdict)).map((p) => p.entryPoint));
    const uncovered = input.entryPoints.filter(
        (e) => !findings.some((f) => f.entryPoint === e) && (!settled.has(e) || undecided.has(e)),
    );

    let verdictState: VerdictOutcome['verdictState'];
    if (unintended.length > 0) verdictState = 'regression';
    else if (intended.length > 0 || uncovered.length > 0 || input.entryPoints.length === 0 || input.diffTruncated) verdictState = 'partly_tested';
    else verdictState = 'no_regressions';

    const forcedNeutral: string[] = [];
    if (input.blockedOutbound) forcedNeutral.push(`${input.blockedOutbound} blocked outbound request${input.blockedOutbound > 1 ? 's' : ''}`);
    if (input.dependencyChangeUntested) forcedNeutral.push('dependency change not behavior-tested');
    if (input.diffTruncated) forcedNeutral.push('diff too large to test whole');

    return { verdictState, findings: unintended, intendedFindings: intended, uncoveredEntryPoints: uncovered, forcedNeutral };
}

/** @deprecated use decideRunVerdict. */
export const aggregateVerdicts = decideRunVerdict;

export interface CheckOutcome {
    conclusion: CheckConclusion;
    title: string;
}

type VerdictForCheck = Pick<VerdictOutcome, 'verdictState' | 'findings' | 'intendedFindings' | 'forcedNeutral'> | { verdictState: 'could_not_boot' };

const emptyVerdict = (verdictState: VerdictState): VerdictForCheck =>
    verdictState === 'could_not_boot' ? { verdictState } : { verdictState, findings: [], intendedFindings: [], forcedNeutral: [] };

/**
 * Maps state + verdictState to the check conclusion and the comment title (§3 table).
 * `securityViolation`: the cell saw the PR's or base's code exfiltrate; a halted Run is then a failure, whatever it tested.
 */
export function checkConclusionFor(state: RunState, verdict?: VerdictForCheck, reason?: string, opts: { securityViolation?: boolean } = {}): CheckOutcome {
    const suffix = (v: typeof verdict) =>
        v && 'forcedNeutral' in v && v.forcedNeutral.length ? ` · ${v.forcedNeutral.join(' · ')}` : '';
    const fromVerdict = (v: NonNullable<typeof verdict>): CheckOutcome => {
        if (v.verdictState === 'could_not_boot') return { conclusion: 'neutral', title: 'Could not boot' };
        const neutralForced = v.forcedNeutral.length > 0;
        if (v.verdictState === 'regression') {
            const n = v.findings.length;
            return { conclusion: 'failure', title: `${n} regression${n === 1 ? '' : 's'}${suffix(v)}` };
        }
        if (v.verdictState === 'partly_tested') {
            const intended = v.intendedFindings.length;
            const title = intended ? `Partly tested · ${intended} intended change${intended === 1 ? '' : 's'}` : 'Partly tested';
            return { conclusion: 'neutral', title: `${title}${suffix(v)}` };
        }
        return {
            conclusion: neutralForced ? 'neutral' : 'success',
            title: `No regressions in what was tested${suffix(v)}`,
        };
    };

    switch (state) {
        case 'no_regressions':
        case 'regression':
        case 'partly_tested':
        case 'could_not_boot':
            return fromVerdict(verdict ?? emptyVerdict(state));
        case 'halted': {
            const base = verdict ? fromVerdict(verdict) : { conclusion: 'neutral' as const, title: 'Partly tested' };
            // Code that exfiltrated is a failure that needs attention, whatever else the Run saw.
            if (opts.securityViolation) return { conclusion: 'failure', title: `Security violation · ${base.title}` };
            // A security event never ends green: a regression stays a failure, anything else is neutral.
            return { conclusion: base.conclusion === 'failure' ? 'failure' : 'neutral', title: `${base.title} · security event` };
        }
        case 'skipped':
            return { conclusion: 'skipped', title: reason ?? 'Skipped' };
        case 'awaiting_approval':
            return { conclusion: 'action_required', title: 'Waiting for a maintainer' };
        case 'superseded':
        case 'cancelled':
            return { conclusion: 'cancelled', title: state === 'superseded' ? 'Superseded by a newer push' : 'Cancelled' };
        case 'timed_out':
            return { conclusion: 'timed_out', title: 'Timed out' };
        case 'errored':
            return { conclusion: 'neutral', title: 'Could not finish' };
        default:
            return { conclusion: 'neutral', title: state };
    }
}

/** @deprecated use checkConclusionFor. */
export const checkFor = checkConclusionFor;
