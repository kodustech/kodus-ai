import type { Task } from './business-validation.types';
import type { TaskQuality } from './judge/validation.types';
import type { BusinessLogicSettings } from './settings';

/** A description shorter than this, with no criteria, does not say what "done" is. */
const MIN_DESCRIPTION = 80;
/** Below this, a description next to a title adds nothing to judge against. */
const MIN_DESCRIPTION_WORDS = 6;

const wordCount = (text: string) =>
    text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

/**
 * How much the task says, graded once here; the judge never regrades it. A
 * sub-issue that says little on its own ("Archive part of the parent") is
 * judged with its parent: its title scopes what the parent asks.
 */
export function gradeTask(task: Task): TaskQuality {
    const own = gradeOwn(task);
    if (
        (own === 'MINIMAL' || own === 'EMPTY') &&
        task.title?.trim() &&
        task.parent?.description &&
        wordCount(task.parent.description) >= MIN_DESCRIPTION_WORDS
    ) {
        return 'PARTIAL';
    }
    return own;
}

function gradeOwn(task: Task): TaskQuality {
    const title = task.title?.trim() ?? '';
    const description = task.description?.trim() ?? '';
    const criteria = (task.acceptanceCriteria ?? []).filter((c) => c.trim());

    if (!title && !description && !criteria.length) {
        return 'EMPTY';
    }
    if (criteria.length || countListItems(description) >= 2) {
        return 'COMPLETE';
    }
    // "Improve tickets" / "Make tickets better." says no more than a bare
    // title: a description counts once it says something.
    if (title && wordCount(description) >= MIN_DESCRIPTION_WORDS) {
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
 * live: a heading in the description, or a field (UC-05, UC-23). When that
 * place isn't on this task (a Git issue has no custom fields), they are
 * detected as with "Detect automatically".
 */
export function applyCriteriaLocation(
    task: Task,
    criteria: BusinessLogicSettings['criteria'],
): Task {
    if (criteria.location === 'auto') {
        return detectCriteria(task);
    }
    const text = criteriaPlaceText(task, criteria);
    if (!text) {
        return detectCriteria(task);
    }
    return { ...task, acceptanceCriteria: criteriaIn(text) };
}

/** The criteria a field or section holds: its list, else one per line. */
function criteriaIn(text: string): string[] {
    const items = listItems(text);
    if (items.length) {
        return items;
    }
    // A field with one criterion per line and no bullets (a Notion property).
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 3);
    return lines.length >= 2 ? lines : [text.trim()];
}

/** What sits where the team said criteria live, when that place is on the task. */
export function criteriaPlaceText(
    task: Task,
    criteria: BusinessLogicSettings['criteria'],
): string | undefined {
    if (criteria.location === 'auto') {
        return undefined;
    }
    const text =
        criteria.location === 'heading'
            ? sectionUnder(task.description ?? '', criteria.heading)
            : fieldText(task, criteria.field);
    return text?.trim() || undefined;
}

/** Headings teams put acceptance criteria under, normalized. */
const CRITERIA_HEADINGS = [
    'acceptance criteria',
    'acceptance criterion',
    'ac',
    'definition of done',
    'dod',
    'requirements',
    'criterios de aceite',
    'criterios de aceitacao',
    'criterio de aceite',
    'criterios de aceptacion',
];

/**
 * Auto: the tracker's own criteria field; else the list under a criteria
 * heading; else the description's list when it has two or more items. What
 * the settings page shows is then what the judge reads.
 */
function detectCriteria(task: Task): Task {
    if (task.acceptanceCriteria?.length) {
        return task;
    }
    // A field named for criteria (a Jira "Acceptance Criteria" field) beats
    // a list in the description, which is as often context as criteria.
    const field = Object.entries(task.fields ?? {}).find(
        ([name, text]) =>
            CRITERIA_HEADINGS.includes(normalize(name)) && text.trim(),
    );
    if (field) {
        return { ...task, acceptanceCriteria: criteriaIn(field[1]) };
    }
    const description = task.description ?? '';
    for (const heading of CRITERIA_HEADINGS) {
        const section = sectionUnder(description, heading);
        const items = section ? listItems(section) : [];
        if (items.length) {
            return { ...task, acceptanceCriteria: items };
        }
    }
    const items = listItems(description);
    return items.length >= 2 ? { ...task, acceptanceCriteria: items } : task;
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
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
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
