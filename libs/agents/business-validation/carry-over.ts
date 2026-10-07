import type {
    BusinessValidationOutcome,
    TaskCheck,
} from './business-validation.types';
import { taskPasses } from './check-policy';
import type { ValidationResult } from './judge/validation.types';
import { deriveStatus } from './judge/validation-verdict';
import type { RunTask } from './runs/validation-run.model';
import type { FailOnState } from './settings';

/**
 * A re-check on top of the PR's previous run: what a reviewer accepted stays
 * accepted (UC-37), and a requirement whose state changed says what it was
 * ("was missing", UC-34).
 */
export function carryOver(
    outcome: BusinessValidationOutcome,
    previous: RunTask[] | undefined,
    failOn: FailOnState[],
): BusinessValidationOutcome {
    if (outcome.kind !== 'validated' || !previous?.length) {
        return outcome;
    }
    const checks = outcome.checks.map((check) => {
        const before = previous.find((t) => t.id === check.task.id);
        return before ? applyPrevious(check, before, failOn) : check;
    });
    return { ...outcome, checks, passed: checks.every((c) => c.passed) };
}

function applyPrevious(
    check: TaskCheck,
    before: RunTask,
    failOn: FailOnState[],
): TaskCheck {
    const earlier = new Map(
        before.requirements.map((r) => [key(r.requirement), r]),
    );
    const requirements = (check.verdict.requirements ?? []).map((r) => {
        const prior = earlier.get(key(r.requirement));
        if (!prior) {
            return r;
        }
        return {
            ...r,
            ...(prior.accepted && r.state !== 'met'
                ? { accepted: prior.accepted }
                : {}),
            ...(prior.state !== r.state ? { previousState: prior.state } : {}),
        };
    });
    const acceptedChanges = new Map(
        before.outOfScope
            .filter((c) => c.accepted)
            .map((c) => [key(c.change), c.accepted!]),
    );
    const outOfScope = (check.verdict.outOfScope ?? []).map((c) => {
        const accepted = acceptedChanges.get(key(c.change));
        return accepted ? { ...c, accepted } : c;
    });
    const verdict: ValidationResult = {
        ...check.verdict,
        requirements,
        outOfScope,
        ...deriveStatus({ ...check.verdict, requirements, outOfScope }),
    };
    return {
        ...check,
        verdict,
        passed: taskPasses(verdict, failOn, check.reference?.intent),
    };
}

/** Requirements are matched by their text, ignoring case, punctuation and spacing. */
function key(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}
