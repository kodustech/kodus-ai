import { CHECK_CONCLUSIONS } from '@libs/runtime/contracts/enums';
import {
    checkConclusionFor,
    type CheckOutcome,
    type RunState,
    type RunStreamEvent,
    type RuntimeRunProjection,
    type VerdictState,
} from '@libs/runtime/run';

// Like safeFailure, public failures select text from code, never from an
// exception. Historical reason strings cannot establish a safe classification.
const ERRORED_REASON = 'Kody Runtime could not finish this run. Try Run again.';
const VERDICTS: ReadonlySet<unknown> = new Set<VerdictState>([
    'no_regressions',
    'regression',
    'partly_tested',
    'could_not_boot',
]);

export function publicRunReason(
    state: RunState,
    reason?: string,
): string | undefined {
    return state === 'errored' ? ERRORED_REASON : reason;
}

/** Keep what Git was told; an internal failure changes the public title, not its recorded conclusion. */
export function publicRunCheck(
    run: Pick<RuntimeRunProjection, 'state' | 'reason' | 'check'>,
): CheckOutcome {
    if (run.state !== 'errored')
        return (
            run.check ?? checkConclusionFor(run.state, undefined, run.reason)
        );
    const fallback = checkConclusionFor('errored');
    const conclusion = run.check?.conclusion;
    return {
        conclusion:
            conclusion && CHECK_CONCLUSIONS.includes(conclusion)
                ? conclusion
                : fallback.conclusion,
        title: fallback.title,
    };
}

/** Only the error-state boundary is narrowed; probes, blockers and evidence retain their existing contracts. */
export function publicRunEvent(event: RunStreamEvent): RunStreamEvent {
    if (event.type !== 'state' || event.data?.state !== 'errored') return event;
    const verdictState = event.data.verdictState;
    return {
        type: 'state',
        at: event.at,
        data: {
            state: 'errored',
            reason: ERRORED_REASON,
            ...(VERDICTS.has(verdictState) ? { verdictState } : {}),
        },
    };
}
