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

/** The text a door that always answers (command, CLI) replies with. */
export function replyFor(outcome: BusinessValidationOutcome): string {
    return outcome.kind === 'validated' ? outcome.report : outcome.message;
}
