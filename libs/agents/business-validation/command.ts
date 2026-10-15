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
            ? `Business logic re-checked: ${outcome.checks.map((c) => c.task.id).join(', ')} ${outcome.passed ? 'met' : 'has open requirements'}.`
            : outcome.message;
    }
    return 'Business logic re-checked. The Kody · Business Logic comment on this pull request is updated.';
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
