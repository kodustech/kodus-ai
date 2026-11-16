import type { BlockerKind, CheckConclusion as SharedCheckConclusion, FindingIntent, FindingKind, Verdict } from '@libs/runtime/contracts/enums';

import type { ReplayLanes } from './replay-lanes';
import type { ResponseDiff } from './response-diff';

// Run lifecycle (docs §3). Every transition is one DBOS step in the
// runtime-worker; the Postgres projection (runtime.runtime_runs) is written by the same step.

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
    'nothing_to_test',
    'superseded',
    'cancelled',
    'timed_out',
    'errored',
    'halted',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * The computed verdict, kept next to `state`. It decides the check even when the Run is halted.
 * `nothing_to_test`: the diff changes nothing that runs (only comments, layout or documentation,
 * read by a parser before anything boots, entry-points/no-effect.ts).
 */
export type VerdictState = 'no_regressions' | 'regression' | 'partly_tested' | 'could_not_boot' | 'nothing_to_test';

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
    'no_regressions',
    'regression',
    'partly_tested',
    'could_not_boot',
    'nothing_to_test',
    'skipped',
    'superseded',
    'cancelled',
    'timed_out',
    'errored',
    'halted',
]);

const TRANSITIONS: Record<RunState, RunState[]> = {
    // partly_tested straight from the queue: a PR that changes only the recipe the Run replaces boots nothing (S-19).
    // nothing_to_test straight from the queue: a PR whose every change is a comment, layout or documentation.
    queued: ['skipped', 'awaiting_approval', 'booting', 'partly_tested', 'nothing_to_test', 'timed_out', 'superseded', 'cancelled'],
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
    nothing_to_test: [],
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
    /**
     * The field extraction the verdict compared with (gate/stability.ts NORMALIZER_VERSION)
     * and the stability policy it started from, history included, as one snapshot (ADR-050).
     * Absent on verdicts decided before they were recorded.
     */
    normalizerVersion?: string;
    stabilityPolicy?: string;
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
    /**
     * The differences the PR's diff spells out (gate/intended-change.ts): each
     * field with main's literal and the PR's, as the diff's removed and added
     * lines hold them (redacted, cut to 200 characters), and the added line.
     * Set, a finding is the PR's intended change (`intent: 'intended'`).
     */
    intendedChange?: Array<{ field: string; base: string; pr: string; file: string; line: number }>;
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
    /** Routes the PR adds that main does not have, answered on the PR: informational, never a finding. */
    newEndpoints: ProbeVerdict[];
    uncoveredEntryPoints: string[];
    forcedNeutral: string[];
}

const DECIDED_WITHOUT_FINDING: ReadonlySet<Verdict> = new Set<Verdict>(['not_reproduced', 'pre_existing', 'new_endpoint']);
/** What settles an entry point: the same result on both sides, or a route the PR adds that main does not have. */
const SETTLES: ReadonlySet<Verdict> = new Set<Verdict>(['not_reproduced', 'new_endpoint']);

/**
 * The verdict table of §3: regression > partly_tested > no_regressions.
 * success needs not_reproduced (or new_endpoint: a route the PR adds, absent
 * on main and answered on the PR) on every entry point of the diff. A
 * pre_existing probe does not satisfy that requirement or invalidate another
 * not_reproduced probe. No probe on that entry point may be undecided: an
 * inconclusive, blocker or unverified probe keeps its entry point uncovered
 * even when another probe settled it.
 */
export function decideRunVerdict(input: VerdictInput): VerdictOutcome {
    const findings = input.probes.filter((p) => p.verdict === 'finding');
    const unintended = findings.filter((p) => p.intent !== 'intended');
    const intended = findings.filter((p) => p.intent === 'intended');

    const settled = new Set(input.probes.filter((p) => SETTLES.has(p.verdict)).map((p) => p.entryPoint));
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

    const newEndpoints = input.probes.filter((p) => p.verdict === 'new_endpoint');
    return { verdictState, findings: unintended, intendedFindings: intended, newEndpoints, uncoveredEntryPoints: uncovered, forcedNeutral };
}

export interface CheckOutcome {
    conclusion: CheckConclusion;
    title: string;
}

type VerdictForCheck =
    | (Pick<VerdictOutcome, 'verdictState' | 'findings' | 'intendedFindings' | 'forcedNeutral'> & Partial<Pick<VerdictOutcome, 'newEndpoints'>>)
    | { verdictState: 'could_not_boot' };

const emptyVerdict = (verdictState: VerdictState): VerdictForCheck =>
    verdictState === 'could_not_boot' ? { verdictState } : { verdictState, findings: [], intendedFindings: [], newEndpoints: [], forcedNeutral: [] };

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The check of a diff that changes nothing that runs: neutral, never green (nothing was tested) and never "partly". */
export const NOTHING_TO_TEST_TITLE = 'Nothing to test at runtime';

/** The verdict of a diff that changes nothing that runs: no probe, no entry point, decided before anything boots. */
export const NOTHING_TO_TEST: VerdictOutcome = { verdictState: 'nothing_to_test', findings: [], intendedFindings: [], newEndpoints: [], uncoveredEntryPoints: [], forcedNeutral: [] };

/** A finding on a route the PR adds (5xx where main has no such route): it fails the check, but it is not a regression against main. */
export const isNewEndpointError = (p: Pick<ProbeVerdict, 'verdict' | 'findingKind'>) => p.verdict === 'finding' && p.findingKind === 'new_endpoint_error';

/** "1 regression · 1 error on a new endpoint": the findings of a failed check, by what they are. */
function findingsTitle(findings: Pick<ProbeVerdict, 'verdict' | 'findingKind'>[]): string {
    const errors = findings.filter(isNewEndpointError).length;
    const regressions = findings.length - errors;
    const parts = [
        ...(regressions || !errors ? [count(regressions, 'regression')] : []),
        ...(errors ? [count(errors, 'error on a new endpoint', 'errors on new endpoints')] : []),
    ];
    return parts.join(' · ');
}

/**
 * Maps state + verdictState to the check conclusion and the comment title (§3 table).
 * `securityViolation`: the cell saw the PR's or base's code exfiltrate; a halted Run is then a failure, whatever it tested.
 */
export function checkConclusionFor(state: RunState, verdict?: VerdictForCheck, reason?: string, opts: { securityViolation?: boolean } = {}): CheckOutcome {
    const suffix = (v: typeof verdict) =>
        v && 'forcedNeutral' in v && v.forcedNeutral.length ? ` · ${v.forcedNeutral.join(' · ')}` : '';
    const fromVerdict = (v: NonNullable<typeof verdict>): CheckOutcome => {
        if (v.verdictState === 'could_not_boot') return { conclusion: 'neutral', title: 'Could not boot' };
        if (v.verdictState === 'nothing_to_test') return { conclusion: 'neutral', title: NOTHING_TO_TEST_TITLE };
        const neutralForced = v.forcedNeutral.length > 0;
        const added = v.newEndpoints?.length ? ` · ${count(v.newEndpoints.length, 'new endpoint')}` : '';
        if (v.verdictState === 'regression') {
            return { conclusion: 'failure', title: `${findingsTitle(v.findings)}${added}${suffix(v)}` };
        }
        if (v.verdictState === 'partly_tested') {
            const intended = v.intendedFindings.length;
            const title = intended ? `Partly tested · ${intended} intended change${intended === 1 ? '' : 's'}` : 'Partly tested';
            return { conclusion: 'neutral', title: `${title}${added}${suffix(v)}` };
        }
        return {
            conclusion: neutralForced ? 'neutral' : 'success',
            title: `No regressions in what was tested${added}${suffix(v)}`,
        };
    };

    switch (state) {
        case 'no_regressions':
        case 'regression':
        case 'partly_tested':
        case 'could_not_boot':
        case 'nothing_to_test':
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
