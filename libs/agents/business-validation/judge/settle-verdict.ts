import type { RequirementVerdict, ValidationResult } from './validation.types';
import { deriveStatus } from './validation-verdict';

export interface SettleInput {
    /** Changed files the judge was not shown because the diff was over budget. */
    unseenFiles: string[];
    /** The task was split into sub-tasks the judge was shown. */
    subtasks?: boolean;
    /** The team wrote guidance the judge was shown. */
    teamGuidance?: boolean;
}

/**
 * The runtime's last word on the judge's verdict. A requirement the code
 * can't prove either way becomes CHECK MANUALLY instead of failing the PR:
 *
 * - the judge is not confident it is missing (UC-31);
 * - it is about how something looks, or a flow the judge can't pin to code
 *   (UC-30);
 * - it may live in a file the judge never saw (UC-32).
 *
 * And a CHECK MANUALLY marked as another piece's work keeps that mark only
 * when the judge had that piece to point at (sub-tasks, team guidance): the
 * mark keeps it from being re-judged, so a judge that pinned it on a helper
 * it couldn't see would hide a gap.
 */
export function settleVerdict(
    result: ValidationResult,
    input: SettleInput,
): ValidationResult {
    if (result.needsMoreInfo || !result.requirements) {
        return result;
    }
    const requirements = result.requirements.map((requirement) =>
        settleRequirement(groundElsewhere(requirement, input), input),
    );
    return {
        ...result,
        requirements,
        ...deriveStatus({ ...result, requirements }),
    };
}

function groundElsewhere(
    requirement: RequirementVerdict,
    input: SettleInput,
): RequirementVerdict {
    const { handledElsewhere: _, ...rest } = requirement;
    if (requirement.state !== 'check_manually') {
        return rest;
    }
    // The prompt has the judge start the note with these words when the
    // sub-tasks or the guidance decided it.
    const note = requirement.note ?? '';
    const marked =
        input.subtasks && /^\s*delivered by\b/i.test(note)
            ? 'sub_task'
            : input.teamGuidance && /^\s*team guidance:/i.test(note)
              ? 'team_guidance'
              : undefined;
    return marked ? { ...rest, handledElsewhere: marked } : rest;
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

    if (requirement.kind === 'visual') {
        return downgrade('visual');
    }
    // A flow gap stands only when the judge is sure and points at the code
    // that skips the step (an action sent with no confirmation first).
    if (
        requirement.kind === 'flow' &&
        (requirement.confidence !== 'high' || !requirement.evidence?.length)
    ) {
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
