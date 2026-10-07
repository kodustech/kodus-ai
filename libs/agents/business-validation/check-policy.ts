import type { ReferenceIntent } from './business-validation.types';
import type { ValidationResult } from './judge/validation.types';
import type { FailOnState } from './settings';

/** What keeps the `kody/business-logic` check from passing for one task. */
export interface Blockers {
    missing: number;
    partial: number;
    notInTask: number;
}

export function countBlockers(verdict: ValidationResult): Blockers {
    const open = (verdict.requirements ?? []).filter((r) => !r.accepted);
    return {
        missing: open.filter((r) => r.state === 'missing').length,
        partial: open.filter((r) => r.state === 'partial').length,
        notInTask: (verdict.outOfScope ?? []).filter((c) => !c.accepted).length,
    };
}

/**
 * Whether one task lets the check pass. MISSING fails by default; PARTIAL
 * and NOT IN TASK only when the team says so (UC-09). CHECK MANUALLY and
 * anything a reviewer accepted never fail. A PR that says it is "part of" a
 * task still shows what's missing, but isn't failed for it (UC-18).
 */
export function taskPasses(
    verdict: ValidationResult,
    failOn: FailOnState[],
    intent: ReferenceIntent | undefined,
): boolean {
    if (verdict.scopeMismatch && intent !== 'part_of') {
        return false;
    }
    if (!verdict.requirements) {
        // A verdict without a requirement list (a model that answered in
        // prose) is read by its status.
        return verdict.status === 'compliant';
    }
    const blockers = countBlockers(verdict);
    const slice = intent === 'part_of';
    return !(
        (failOn.includes('missing') && !slice && blockers.missing > 0) ||
        (failOn.includes('partial') && !slice && blockers.partial > 0) ||
        (failOn.includes('not_in_task') && blockers.notInTask > 0)
    );
}
