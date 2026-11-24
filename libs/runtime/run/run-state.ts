import { type BlockerKind, type CheckConclusion as SharedCheckConclusion, DEFAULT_PARTLY_TESTED_CHECK, type FindingIntent, type FindingKind, type PartlyTestedCheck, type Verdict } from '@libs/runtime/contracts/enums';

import { type ExercisedSummary, exercisedShortfall } from './exercised-lines';
import type { LeafChangeSet } from './leaf-changes';
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
    // errored straight from the queue: a workflow that failed before it booted, or never started (the sweep).
    queued: ['skipped', 'awaiting_approval', 'booting', 'partly_tested', 'nothing_to_test', 'errored', 'timed_out', 'superseded', 'cancelled'],
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

/**
 * What one intent probe's assertions did on a probe's PR rounds
 * (gate/stated-intent.ts, docs/runtime/intent-oracle.md): the sentence of the
 * PR they quote, how many held, and each one that failed with what it
 * expected and received (values cut and redacted).
 */
export interface ProbeStatedIntent {
    /** The intent probe that carries the assertions. */
    probeId: string;
    quote: string;
    /** `description` or `task:<id>`. */
    source: string;
    /** The intent probe's request as sent (`POST /orders/quote {"item":…}`), redacted and cut. */
    request?: string;
    assertions: number;
    held: number;
    /** Assertions no round could evaluate: neither held nor failed. Absent on Runs before it. */
    inconclusive?: number;
    failures: Array<{ assertion: string; expected: string; received: string }>;
}

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
     * characters. Shown on the Run page only: never in the PR comment (ADR-052; amended
     * only for `leafChanges`, the few cleaned leaves of a finding on an object or
     * array field, which the comment names), and no
     * verdict reads it.
     */
    responseDiff?: ResponseDiff;
    /**
     * The HTTP status of each side when they differ (response-diff.ts statusChangeOf):
     * the change the PR list leads with. Shown only: no verdict reads it.
     */
    statusChange?: { base: number; pr: number };
    /**
     * A `behavior_change` finding on an object or array field, leaf by leaf
     * (gate/leaf-changes.ts): what differs inside the field and which leaves a
     * passed assertion of the PR's text reads. The gate's fields and names are
     * unchanged; this is computed after the gate from the two stored values.
     */
    leafChanges?: LeafChangeSet;
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
    /**
     * Where the probe came from when it is not the Run's plan: a kept check
     * (docs/runtime/kept-checks.md), played on base and PR through the same gate,
     * or an intent probe the intent author wrote from the PR's text
     * (docs/runtime/intent-oracle.md). Absent: the planner's (or an external finding's) probe.
     */
    source?: 'kept_check' | 'intent';
    /** The kept check this probe played, with `source: 'kept_check'`. */
    keptCheckId?: string;
    /**
     * The PR's stated intent checked on this probe's PR rounds: an intent
     * probe's own, or, on a planned probe, those of an intent probe of the
     * same request. A failure never fails the check; all held may make the
     * difference a `described_change`.
     */
    statedIntents?: ProbeStatedIntent[];
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
    /**
     * The two sides' claims did not carry the same drawn identity (S-36): one
     * cell did not set it, or the two differ. The probes that use its tokens
     * are already inconclusive; the Run is partly tested at best.
     */
    identityMismatch?: boolean;
    /**
     * Which changed lines ran (exercised-lines.ts). Below its threshold, a Run
     * that would be green is partly tested; nothing measured changes nothing.
     */
    exercised?: ExercisedSummary;
    /**
     * Kept checks of the repository this Run could not play as kept: stale,
     * skipped by the budget, or undecided (docs/runtime/kept-checks.md §6). A
     * Run that would be green is partly tested; a regression stays one.
     */
    keptChecksNotRun?: number;
    /**
     * The PR's machine did not boot while the base did, and the egress proxy
     * denied it these hosts (its structured record, never the PR's output):
     * not a regression, a host to approve. The Run is partly tested and its
     * check needs action whatever the org's fallback (owner decision D7 of
     * 2026-11-18, docs/runtime/egress-allowlist.md §15).
     */
    prEgressDenied?: string[];
    /**
     * The failures of the repository's e2e suite that are neither a regression nor ruled out (unclassified, unconfirmed,
     * probable): a Run that would be green is partly tested, never "no regressions" with part of the suite unknown
     * (docs/runtime/e2e-suites.md section 10.2). A regression of the suite is a finding among `probes`.
     */
    suiteUnclassified?: number;
    /** The repository's e2e suite was asked for and did not run, or did not finish: the Run cannot say it tested the suite. */
    suiteNotRun?: boolean;
    /** Why the suite could not start, in the check's words (suiteVerdictParts). */
    suiteNotRunWhy?: string;
}

export interface VerdictOutcome {
    verdictState: Exclude<VerdictState, 'could_not_boot'>;
    findings: ProbeVerdict[];
    intendedFindings: ProbeVerdict[];
    /** Routes the PR adds that main does not have, answered on the PR: informational, never a finding. */
    newEndpoints: ProbeVerdict[];
    /** Differences from main the PR's text describes and that held (docs/runtime/intent-oracle.md): never a finding. */
    describedChanges?: ProbeVerdict[];
    /** Probes whose answer on the PR breaks an assertion quoted from the PR's text: advisory, never a failure on their own. */
    intentMismatches?: ProbeVerdict[];
    uncoveredEntryPoints: string[];
    forcedNeutral: string[];
    /** A partly tested Run with nothing to test: no entry point of the diff and no probe. Its check stays neutral. */
    nothingToTest?: true;
    /** Causes that hold the check at action_required whatever the org's fallback: a PR boot the egress proxy stopped. */
    actionRequired?: string[];
}

const DECIDED_WITHOUT_FINDING: ReadonlySet<Verdict> = new Set<Verdict>(['not_reproduced', 'pre_existing', 'new_endpoint', 'described_change', 'intent_mismatch']);
/**
 * What settles an entry point: the same result on both sides, a route the PR
 * adds that main does not have, or a difference the PR describes that held.
 * An intent mismatch settles nothing.
 */
const SETTLES: ReadonlySet<Verdict> = new Set<Verdict>(['not_reproduced', 'new_endpoint', 'described_change']);

/** A probe whose answer on the PR breaks an assertion quoted from the PR's text. */
export const breaksStatedIntent = (p: Pick<ProbeVerdict, 'statedIntents'>) => !!p.statedIntents?.some((s) => s.failures.length > 0);

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
    // An intent probe the gate could not decide holds nothing back: the oracle is advisory until measured.
    const undecided = new Set(input.probes.filter((p) => p.verdict !== 'finding' && !DECIDED_WITHOUT_FINDING.has(p.verdict) && p.source !== 'intent').map((p) => p.entryPoint));
    const uncovered = input.entryPoints.filter(
        (e) => !findings.some((f) => f.entryPoint === e) && (!settled.has(e) || undecided.has(e)),
    );

    let verdictState: VerdictOutcome['verdictState'];
    if (unintended.length > 0) verdictState = 'regression';
    else if (intended.length > 0 || uncovered.length > 0 || input.entryPoints.length === 0 || input.diffTruncated || input.identityMismatch) verdictState = 'partly_tested';
    else verdictState = 'no_regressions';

    const forcedNeutral: string[] = [];
    // Only a green Run is held back: the rule never upgrades and never touches a regression.
    const shortfall = verdictState === 'no_regressions' ? exercisedShortfall(input.exercised) : undefined;
    if (shortfall) {
        verdictState = 'partly_tested';
        forcedNeutral.push(shortfall);
    }
    // A kept check that could not run is not "no regression": like the shortfall, it only holds a green Run back.
    const notRun = input.keptChecksNotRun ?? 0;
    if (notRun > 0 && verdictState !== 'regression') {
        verdictState = 'partly_tested';
        forcedNeutral.push(`${notRun} kept check${notRun > 1 ? 's' : ''} could not run`);
    }
    // The suite's undecided failures hold a green Run back, as an unrun kept check does; a regression stays one.
    const suiteUndecided = input.suiteUnclassified ?? 0;
    if (suiteUndecided > 0 && verdictState !== 'regression') {
        verdictState = 'partly_tested';
        forcedNeutral.push(`${suiteUndecided} e2e failure${suiteUndecided > 1 ? 's' : ''} not classified`);
    }
    if (input.suiteNotRun && verdictState !== 'regression') {
        verdictState = 'partly_tested';
        forcedNeutral.push(input.suiteNotRunWhy ? `the e2e suite could not run: ${input.suiteNotRunWhy}` : 'the e2e suite could not run');
    }
    if (input.blockedOutbound) forcedNeutral.push(`${input.blockedOutbound} blocked outbound request${input.blockedOutbound > 1 ? 's' : ''}`);
    if (input.dependencyChangeUntested) forcedNeutral.push('dependency change not behavior-tested');
    if (input.diffTruncated) forcedNeutral.push('diff too large to test whole');
    if (input.identityMismatch) forcedNeutral.push('the two sides ran with different drawn identities');
    // Every cause that holds the check at neutral holds the stored state too: the timeline, the
    // metrics and a check rebuilt from the state never read green where the check is not.
    if (forcedNeutral.length && verdictState === 'no_regressions') verdictState = 'partly_tested';

    const actionRequired = input.prEgressDenied?.length && verdictState !== 'regression' ? [deniedHostsCause(input.prEgressDenied)] : [];
    if (actionRequired.length) verdictState = 'partly_tested';
    const nothingToTest = verdictState === 'partly_tested' && !input.entryPoints.length && !input.probes.length && !forcedNeutral.length && !actionRequired.length;

    const newEndpoints = input.probes.filter((p) => p.verdict === 'new_endpoint');
    return {
        verdictState,
        findings: unintended,
        intendedFindings: intended,
        newEndpoints,
        describedChanges: input.probes.filter((p) => p.verdict === 'described_change'),
        intentMismatches: input.probes.filter(breaksStatedIntent),
        uncoveredEntryPoints: uncovered,
        forcedNeutral,
        ...(nothingToTest ? { nothingToTest: true as const } : {}),
        ...(actionRequired.length ? { actionRequired } : {}),
    };
}

/** "the PR's machine was denied api.example.com": the cause a check names for a PR boot the egress proxy stopped. */
export function deniedHostsCause(hosts: readonly string[]): string {
    const shown = hosts.slice(0, 2).join(', ');
    return `the PR's machine was denied ${shown}${hosts.length > 2 ? ` and ${hosts.length - 2} more` : ''}`;
}

export interface CheckOutcome {
    conclusion: CheckConclusion;
    title: string;
}

type VerdictForCheck =
    | (Pick<VerdictOutcome, 'verdictState' | 'findings' | 'intendedFindings' | 'forcedNeutral'> &
          Partial<Pick<VerdictOutcome, 'newEndpoints' | 'describedChanges' | 'intentMismatches' | 'nothingToTest' | 'actionRequired'>>)
    | { verdictState: 'could_not_boot' };

export interface CheckOptions {
    /** The cell saw the PR's or base's code exfiltrate; a halted Run is then a failure, whatever it tested. */
    securityViolation?: boolean;
    /**
     * What a partly tested Run with something left to decide concludes with:
     * the org's setting when the Run was asked (DEFAULT_PARTLY_TESTED_CHECK
     * when absent). Nothing to test stays neutral and an egress-stopped PR
     * boot stays action_required, whatever it says.
     */
    partlyTestedCheck?: PartlyTestedCheck;
}

const SEVERITY: Record<CheckConclusion, number> = { success: 0, skipped: 1, neutral: 2, action_required: 3, cancelled: 3, timed_out: 3, failure: 4 };

/**
 * The check of a verdict state read without its verdict (the projection before
 * the verdict's check is written): never success, since nothing says what was
 * tested, and never a count it does not have.
 */
function stateOnlyCheck(state: RunState, opts: CheckOptions = {}): CheckOutcome {
    if (state === 'regression') return { conclusion: 'failure', title: 'Regression found' };
    if (state === 'could_not_boot') return { conclusion: 'neutral', title: 'Could not boot' };
    if (state === 'nothing_to_test') return { conclusion: 'neutral', title: NOTHING_TO_TEST_TITLE };
    if (state === 'no_regressions') return { conclusion: 'neutral', title: 'No regressions in what was tested' };
    // Nothing says whether something was left to decide: as if something was.
    return { conclusion: partlyTestedConclusion(opts), title: 'Partly tested' };
}

const partlyTestedConclusion = (opts: CheckOptions): CheckConclusion => opts.partlyTestedCheck ?? DEFAULT_PARTLY_TESTED_CHECK;

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
 *
 * A partly tested Run (or a green one a forced cause holds back) has
 * something left to decide: an intended change, an inconclusive or blocked
 * path, a boot put down to the cell, a coverage shortfall. Its check is
 * action_required, which a branch protection does not pass, unless the org
 * chose neutral (`opts.partlyTestedCheck`). One with nothing to test
 * (`nothingToTest`) stays neutral, and one whose PR boot the egress proxy
 * stopped (`actionRequired`) stays action_required, whatever the org chose
 * (owner decisions of 2026-11-18).
 */
export function checkConclusionFor(state: RunState, verdict?: VerdictForCheck, reason?: string, opts: CheckOptions = {}): CheckOutcome {
    const causes = (v: typeof verdict) => (v && 'forcedNeutral' in v ? [...(v.actionRequired ?? []), ...v.forcedNeutral] : []);
    const suffix = (v: typeof verdict) => (causes(v).length ? ` · ${causes(v).join(' · ')}` : '');
    const soft = (v: Exclude<NonNullable<typeof verdict>, { verdictState: 'could_not_boot' }>): CheckConclusion => {
        if (v.actionRequired?.length) return 'action_required';
        if (v.nothingToTest && !v.intendedFindings.length && !v.forcedNeutral.length) return 'neutral';
        return partlyTestedConclusion(opts);
    };
    const fromVerdict = (v: NonNullable<typeof verdict>): CheckOutcome => {
        if (v.verdictState === 'could_not_boot') return { conclusion: 'neutral', title: 'Could not boot' };
        if (v.verdictState === 'nothing_to_test') return { conclusion: 'neutral', title: NOTHING_TO_TEST_TITLE };
        const held = v.forcedNeutral.length > 0 || !!v.actionRequired?.length;
        const added = [
            ...(v.newEndpoints?.length ? [count(v.newEndpoints.length, 'new endpoint')] : []),
            ...(v.describedChanges?.length ? [count(v.describedChanges.length, 'described change')] : []),
            ...(v.intentMismatches?.length ? [`${v.intentMismatches.length} not what the PR describes`] : []),
        ]
            .map((part) => ` · ${part}`)
            .join('');
        if (v.verdictState === 'regression') {
            return { conclusion: 'failure', title: `${findingsTitle(v.findings)}${added}${suffix(v)}` };
        }
        if (v.verdictState === 'partly_tested') {
            const intended = v.intendedFindings.length;
            const title = intended ? `Partly tested · ${intended} intended change${intended === 1 ? '' : 's'}` : 'Partly tested';
            return { conclusion: soft(v), title: `${title}${added}${suffix(v)}` };
        }
        return {
            conclusion: held ? soft(v) : 'success',
            title: `No regressions in what was tested${added}${suffix(v)}`,
        };
    };

    switch (state) {
        case 'no_regressions':
        case 'regression':
        case 'partly_tested':
        case 'could_not_boot':
        case 'nothing_to_test': {
            if (!verdict) return stateOnlyCheck(state, opts);
            const computed = fromVerdict(verdict);
            if (verdict.verdictState === state) return computed;
            // A verdict that disagrees with the stored state: the more severe of the two, never green.
            const stored = stateOnlyCheck(state, opts);
            return SEVERITY[stored.conclusion] > SEVERITY[computed.conclusion] ? stored : computed.conclusion === 'success' ? { ...computed, conclusion: 'neutral' } : computed;
        }
        case 'halted': {
            const base = verdict ? fromVerdict(verdict) : { conclusion: 'neutral' as const, title: 'Partly tested' };
            // Code that exfiltrated is a failure that needs attention, whatever else the Run saw.
            if (opts.securityViolation) return { conclusion: 'failure', title: `Security violation · ${base.title}` };
            // A security event never ends green: a regression stays a failure, what still needs action keeps
            // needing it, anything else is neutral.
            const conclusion = base.conclusion === 'failure' || base.conclusion === 'action_required' ? base.conclusion : 'neutral';
            return { conclusion, title: `${base.title} · security event` };
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
