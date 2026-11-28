import { withoutLeadingQuote } from '@libs/common/utils/codeManagement/codeCommentMarkers';
import type {
    BusinessValidationOutcome,
    Task,
    TaskReference,
} from './business-validation.types';

const COMMAND = /@kody\s+-v\s+business-logic\b/i;

/** Text passed to the command that names no task is the task itself, if it says this much. */
const MIN_INLINE_TASK = 40;

/**
 * What follows `@kody -v business-logic` in a comment: a task id, a link, or
 * the task itself. A quote the comment opens with is not read: quoting Kody's
 * comment would otherwise pass its footer or example as the task.
 */
export function commandArgument(
    comment: string | undefined,
): string | undefined {
    const text = comment && withoutLeadingQuote(comment);
    const match = text?.match(COMMAND);
    if (!match || match.index === undefined) {
        return undefined;
    }
    const rest = text!.slice(match.index + match[0].length).trim();
    return rest || undefined;
}

/**
 * What the command replies once the outcome is on the PR. A verdict, a task
 * too thin or a typo went into the Business Logic comment, so the reply only
 * points there; anything else is the reason nothing was checked. The first
 * run posts that comment, so it can't say the comment was updated. On a
 * re-check it says whether the result changed (#2423): an edit that keeps
 * the same verdict is not news.
 */
export function replyFor(
    outcome: BusinessValidationOutcome,
    comment: 'created' | 'updated' | 'none',
    /** On an edited comment: whether the result differs from the last one. */
    changed?: boolean,
): string {
    if (outcome.kind === 'skipped') {
        return outcome.message;
    }
    const verdict =
        outcome.kind === 'validated'
            ? `${outcome.checks.map((c) => c.task.id).join(', ')} ${outcome.passed ? 'met' : 'has open requirements'}`
            : undefined;
    if (comment === 'none') {
        return outcome.kind === 'validated'
            ? `Business logic re-checked: ${verdict}.`
            : outcome.message;
    }
    if (comment === 'created') {
        return 'Business logic checked. The result is in the Kody · Business Logic comment on this pull request.';
    }
    if (changed === false) {
        return `Business logic re-checked: same result as before${verdict ? `, ${verdict}` : ''}. The Kody · Business Logic comment on this pull request shows it.`;
    }
    // Unknown (no earlier run to compare with): the comment was edited, and
    // nothing is claimed about the result.
    const news =
        changed === true
            ? `: the result changed${verdict ? `, ${verdict}` : ''}`
            : '';
    return `Business logic re-checked${news}. The Kody · Business Logic comment on this pull request is updated.`;
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
