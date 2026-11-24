import { type Classification } from '@libs/runtime/suite';

import type { ProbeVerdict } from './run-state';

// The suite's part of a Run's verdict (docs/runtime/e2e-suites.md section 10.2). Pure: the classification in, findings and
// counts out; `decideRunVerdict` reads them.

const REASON_MAX = 200;

/** Failures that are neither confirmed regressions nor ruled out as someone else's fault: the Run cannot call itself green. */
const UNDECIDED: ReadonlySet<string> = new Set(['unclassified', 'failed_unconfirmed', 'regression_unconfirmed', 'regression_probable']);

/** Each regression is a finding of kind `e2e_regression`; flaky, pre-existing and the rest are the report's "E2E suite" section only. */
export function suiteFindingsOf(classification: Classification | undefined): ProbeVerdict[] {
    return (classification?.tests ?? [])
        .filter((t) => t.class === 'regression')
        .map((t) => ({
            probeId: `suite:${t.spec}:${t.title}`,
            entryPoint: t.spec,
            exercised: `${t.spec} › ${t.title}`.slice(0, REASON_MAX),
            verdict: 'finding' as const,
            findingKind: 'e2e_regression' as const,
            reason: `failed on the PR twice and passed on main${t.prSignature ? `: ${t.prSignature}` : ''}`.slice(0, REASON_MAX),
        }));
}

export const suiteUnclassifiedCount = (classification: Classification | undefined): number => (classification?.tests ?? []).filter((t) => UNDECIDED.has(t.class)).length;

/** What a suite stage ended as, as far as the Run's verdict reads it. */
export interface SuiteStageResult {
    /** `off`: the environment has no suite to run. `unavailable`: it could not start. */
    status: 'ran' | 'unavailable' | 'off';
    /** The suite run's state when it ran. */
    state?: 'passed' | 'failed' | 'neutral' | 'timed_out' | 'cancelled' | 'errored';
    classification?: Classification;
    /** A canary was found in an artifact the suite kept: the Run halts as it does for a canary anywhere else. */
    leaked?: boolean;
}

/** The suite's part of the verdict: findings, the failures left undecided, and whether the suite did not run or finish. */
export function suiteVerdictParts(r: SuiteStageResult | undefined): { findings: ProbeVerdict[]; unclassified: number; notRun: boolean } {
    if (!r || r.status === 'off') return { findings: [], unclassified: 0, notRun: false };
    if (r.status === 'unavailable') return { findings: [], unclassified: 0, notRun: true };
    // A run that timed out, was cancelled or errored never reached its classification: what it did not decide is not "tested".
    const finished = r.state === 'passed' || r.state === 'failed' || r.state === 'neutral';
    return { findings: suiteFindingsOf(r.classification), unclassified: suiteUnclassifiedCount(r.classification), notRun: !finished };
}
