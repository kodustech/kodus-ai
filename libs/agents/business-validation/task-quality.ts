import type { Task } from './business-validation.types';
import type { TaskQuality } from './judge/validation.types';

/** A description shorter than this, with no criteria, does not say what "done" is. */
const MIN_DESCRIPTION = 80;

/** How much the task says, graded once here; the judge never regrades it. */
export function gradeTask(task: Task): TaskQuality {
    const title = task.title?.trim() ?? '';
    const description = task.description?.trim() ?? '';
    const criteria = (task.acceptanceCriteria ?? []).filter((c) => c.trim());

    if (!title && !description && !criteria.length) {
        return 'EMPTY';
    }
    if (criteria.length || countListItems(description) >= 2) {
        return 'COMPLETE';
    }
    if (title && description) {
        return 'PARTIAL';
    }
    if (description) {
        return description.length >= MIN_DESCRIPTION ? 'PARTIAL' : 'MINIMAL';
    }
    return 'MINIMAL';
}

/** True when the judge can compare the code against it. */
export function canJudgeAgainst(quality: TaskQuality): boolean {
    return quality === 'PARTIAL' || quality === 'COMPLETE';
}

/** The task as the judge reads it. */
export function formatTaskForJudge(task: Task): string {
    const sections = [`Task ID: ${task.id}`];
    if (task.title) {
        sections.push(`Title: ${task.title}`);
    }
    if (task.description) {
        sections.push(`Description:\n${task.description}`);
    }
    if (task.acceptanceCriteria?.length) {
        sections.push(
            `Acceptance Criteria:\n${task.acceptanceCriteria
                .map((item) => `- ${item}`)
                .join('\n')}`,
        );
    }
    if (task.url) {
        sections.push(`Links:\n- ${task.url}`);
    }
    return sections.join('\n\n');
}

function countListItems(text: string): number {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) =>
            /^(?:[-*]\s+|\d+\.\s+)(?!\[[ xX]\]\s*$).{10,}$/u.test(line),
        ).length;
}
