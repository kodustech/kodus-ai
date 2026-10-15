import type { ReferenceIntent } from './business-validation.types';
import type { ValidationResult } from './judge/validation.types';

/** What the verdict leaves open on one task. */
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
 * Whether one task passes: nothing MISSING. PARTIAL is a judgment call that
 * can flip between two runs of the same code, and NOT IN TASK is often a
 * fair refactor, so both are shown without failing. CHECK MANUALLY and
 * anything a reviewer accepted never fail. A PR that says it is "part of" a
 * task still shows what's missing, but isn't failed for it (UC-18).
 */
export function taskPasses(
    verdict: ValidationResult,
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
    return intent === 'part_of' || countBlockers(verdict).missing === 0;
}
