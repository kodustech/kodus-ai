import type { RequirementVerdict, ValidationResult } from './validation.types';
import { deriveStatus } from './validation-verdict';

export interface SettleInput {
    /** Changed files the judge was not shown because the diff was over budget. */
    unseenFiles: string[];
}

/**
 * The runtime's last word on the judge's verdict. A requirement the code
 * can't prove either way becomes CHECK MANUALLY instead of failing the PR:
 *
 * - the judge is not confident it is missing (UC-31);
 * - it is about how something looks or flows, not what the code does (UC-30);
 * - it may live in a file the judge never saw (UC-32).
 */
export function settleVerdict(
    result: ValidationResult,
    input: SettleInput,
): ValidationResult {
    if (result.needsMoreInfo || !result.requirements) {
        return result;
    }
    const requirements = result.requirements.map((requirement) =>
        settleRequirement(requirement, input),
    );
    return {
        ...result,
        requirements,
        ...deriveStatus({ ...result, requirements }),
    };
}

function settleRequirement(
    requirement: RequirementVerdict,
    input: SettleInput,
): RequirementVerdict {
    if (requirement.state !== 'missing' && requirement.state !== 'partial') {
        return requirement;
    }
    // The renderer says why, in the team's language.
    const downgrade = (
        reason: NonNullable<RequirementVerdict['downgraded']>,
    ): RequirementVerdict => ({
        ...requirement,
        state: 'check_manually',
        judgedState: requirement.state,
        downgraded: reason,
    });

    if (requirement.kind === 'visual' || requirement.kind === 'flow') {
        return downgrade('visual');
    }
    if (requirement.confidence === 'low') {
        return downgrade('low_confidence');
    }
    if (requirement.state === 'missing' && input.unseenFiles.length) {
        return downgrade('not_in_diff');
    }
    return requirement;
}
