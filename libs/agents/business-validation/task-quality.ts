import type { Task } from './business-validation.types';
import type { TaskQuality } from './judge/validation.types';
import type { BusinessLogicSettings } from './settings';

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

/**
 * The task with its acceptance criteria taken from where the team said they
 * live: a heading in the description, or a field (UC-05, UC-23). Left as is
 * when that place is empty, so the judge still reads the whole description.
 */
export function applyCriteriaLocation(
    task: Task,
    criteria: BusinessLogicSettings['criteria'],
): Task {
    if (criteria.location === 'auto') {
        return task;
    }
    const text =
        criteria.location === 'heading'
            ? sectionUnder(task.description ?? '', criteria.heading)
            : fieldText(task, criteria.field);
    const items = text ? listItems(text) : [];
    if (items.length) {
        return { ...task, acceptanceCriteria: items };
    }
    return text ? { ...task, acceptanceCriteria: [text.trim()] } : task;
}

function sectionUnder(
    description: string,
    heading: string,
): string | undefined {
    const lines = description.split('\n');
    const wanted = normalize(heading);
    const start = lines.findIndex((line) => {
        const match = line.match(/^\s*(?:#{1,6}\s+|\*\*)?(.+?)(?:\*\*)?:?\s*$/);
        return match ? normalize(match[1]) === wanted : false;
    });
    if (start < 0) {
        return undefined;
    }
    const level = (lines[start].match(/^\s*(#{1,6})\s/)?.[1] ?? '').length;
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const next = line.match(/^\s*(#{1,6})\s/);
        if (next && (!level || next[1].length <= level)) {
            break;
        }
        body.push(line);
    }
    const text = body.join('\n').trim();
    return text || undefined;
}

function fieldText(task: Task, field: string): string | undefined {
    const fields = task.fields ?? {};
    const wanted = normalize(field);
    const key = Object.keys(fields).find((k) => normalize(k) === wanted);
    return key ? fields[key] : undefined;
}

function listItems(text: string): string[] {
    return text
        .split('\n')
        .map((line) =>
            line
                .trim()
                .match(/^(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+\.\s+)(.+)$/)?.[1]
                ?.trim(),
        )
        .filter((item): item is string => !!item && item.length > 3);
}

function normalize(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
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
    if (task.hasAttachments) {
        sections.push(
            'Attachments: the task has images or files that are not shown here. Requirements that depend on them are visual: mark them check_manually.',
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
