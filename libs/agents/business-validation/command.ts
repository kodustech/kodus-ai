import type {
    BusinessValidationOutcome,
    Task,
    TaskReference,
} from './business-validation.types';

const COMMAND = /@kody\s+-v\s+business-logic\b/i;

/** Text passed to the command that names no task is the task itself, if it says this much. */
const MIN_INLINE_TASK = 40;

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
 * points there; anything else is the reason nothing was checked. The first
 * run posts that comment, so it can't say the comment was updated; a re-check
 * says whether its text changed, and claims an update only when it did.
 */
export function replyFor(
    outcome: BusinessValidationOutcome,
    comment: 'created' | 'updated' | 'none',
    changed?: boolean,
): string {
    if (outcome.kind === 'skipped') {
        return outcome.message;
    }
    const verdict =
        outcome.kind === 'validated'
            ? `Business logic re-checked: ${outcome.checks.map((c) => c.task.id).join(', ')} ${outcome.passed ? 'met' : 'has open requirements'}.`
            : outcome.message;
    if (comment === 'none') {
        return verdict;
    }
    if (comment === 'created') {
        return 'Business logic checked. The result is in the Kody · Business Logic comment on this pull request.';
    }
    return `${verdict} ${recheckNotice(changed)}`;
}

/**
 * What a re-check says about the Business Logic comment, in ONE place: the
 * command reply and the two thread replies carried four near-copies of this
 * sentence and had already drifted, so the next wording change would have
 * landed in one path and described the same status differently in another.
 */
export function recheckNotice(changed?: boolean): string {
    if (changed === false) {
        return 'The result did not change; the Kody · Business Logic comment says the same.';
    }
    if (changed === true) {
        return 'The Kody · Business Logic comment is updated.';
    }
    return 'The result is in the Kody · Business Logic comment on this pull request.';
}

/** Text given to the command that is not a reference is the task itself. */
export function inlineTask(
    taskInput: string | undefined,
    references: TaskReference[],
): Task | undefined {
    const text = taskInput?.trim() ?? '';
    if (text.length < MIN_INLINE_TASK) {
        return undefined;
    }
    if (references.some((r) => r.source === 'command')) {
        return undefined;
    }
    // The text IS the task: give it a title so it grades as judgeable
    // even when it is shorter than a tracker description.
    return {
        tracker: 'the command',
        id: 'Task in the command',
        title: text.split('\n')[0].slice(0, 120),
        description: text,
    };
}
