import type { BusinessValidationOutcome } from './business-validation.types';

const COMMAND = /@kody\s+-v\s+business-logic\b/i;

/** What follows `@kody -v business-logic` in a comment: a task id, a link, or the task itself. */
export function commandArgument(
    comment: string | undefined,
): string | undefined {
    const match = comment?.match(COMMAND);
    if (!match || match.index === undefined) {
        return undefined;
    }
    const rest = comment!.slice(match.index + match[0].length).trim();
    return rest || undefined;
}

/**
 * What the command replies once the outcome is on the PR. A verdict, a task
 * too thin or a typo went into the Business Logic comment, so the reply only
 * points there; anything else is the reason nothing was checked.
 */
export function replyFor(
    outcome: BusinessValidationOutcome,
    commented: boolean,
): string {
    if (outcome.kind === 'skipped') {
        return outcome.message;
    }
    if (!commented) {
        return outcome.kind === 'validated'
            ? `Business logic re-checked: ${outcome.checks.map((c) => c.task.id).join(', ')} ${outcome.passed ? 'met' : 'has open requirements'}. See the kody/business-logic check.`
            : outcome.message;
    }
    return 'Business logic re-checked. The Kody · Business Logic comment on this pull request is updated.';
}
