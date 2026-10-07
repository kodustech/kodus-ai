import type {
    ResolutionAttempt,
    Task,
    TaskReference,
} from './business-validation.types';

/**
 * What the PR author reads. English here; the service rewrites it in the
 * team's language. Each message says what happened and what to do next.
 */

const RERUN = '`@kody -v business-logic`';

export function taskTooThinMessage(tasks: Task[]): string {
    const task = tasks[0];
    const others = tasks.slice(1).map((t) => `**${t.id}**`);
    return `## 🤔 ${task.id} has only a title

I read **${task.id}** in ${task.tracker}${task.title ? ` (“${task.title}”)` : ''}, but it doesn't say what "done" means, so there is nothing to compare this pull request with.${others.length ? ` The same goes for ${others.join(', ')}.` : ''}

### 💡 Next step
Add acceptance criteria to ${task.id} (for example: what the feature must do, which cases it covers, what it must not change) and comment ${RERUN}.`;
}

export function tooManyReferencesMessage(count: number): string {
    return `## 🤔 Too many tasks referenced

This pull request references ${count} tasks, which reads like a release or a merge rather than one task's work, so nothing was validated. Run ${RERUN} followed by the one task id to check it against this pull request.`;
}

/** A reference whose prefix is a real team or project, but no such task (UC-21). */
export function taskMissingMessage(
    reference: TaskReference,
    tracker: string,
    nearby: string[],
): string {
    const prefix = reference.id.split('-')[0];
    const closest = nearby.length
        ? ` The closest existing tasks are ${nearby.map((id) => `**${id}**`).join(' and ')}.`
        : '';
    return `## 🤔 ${reference.id} doesn't exist in ${tracker}

${prefix} is a team in your ${tracker}, so \`${reference.raw}\` looks like a task id. Maybe a typo?${closest}

### 💡 Next step
Fix the reference in the title or description and comment ${RERUN}.`;
}

export function noReferenceMessage(): string {
    return `## 🤔 No task found

This pull request doesn't reference a task. Reference it in the title, description or branch (\`PROJ-123\`, \`#123\` or a link), or run ${RERUN} followed by the task id or link.`;
}

export function noTrackerMessage(): string {
    return 'No task-management MCP (Jira, Git Issues, Linear, Notion, ClickUp, etc.) is connected for this organization, so business rules validation has nothing to compare the PR against. Connect one in the Kodus settings to use this command.';
}

export function noCapableTrackerMessage(
    references: TaskReference[],
    trackers: string[],
): string {
    return `## 🤔 I can't read the referenced task

${listReferences(references)} can't be read by the connected task tools (${trackers.join(', ')}). Connect the tracker where it lives, or reference a task from one of these.`;
}

export function taskNotFoundMessage(attempts: ResolutionAttempt[]): string {
    const tried = [
        ...new Set(attempts.map((a) => `${a.reference} in ${a.tracker}`)),
    ];
    return `## 🤔 Task not found

I looked for ${tried.join(', ')} and it doesn't exist there. Check the reference in the title, description or branch, then comment ${RERUN}.`;
}

export function trackerUnavailableMessage(
    attempts: ResolutionAttempt[],
): string {
    const failed = attempts.filter((a) => a.status === 'error');
    const trackers = [...new Set(failed.map((a) => a.tracker))];
    return `## ⚠️ ${trackers.join(', ') || 'The task tracker'} didn't answer

I couldn't read the referenced task, so nothing was validated. This is not about the pull request; try ${RERUN} again later, or ask an admin to check the plugin connection.`;
}

export function diffUnavailableMessage(): string {
    return `## 🤔 Need Pull Request Diff

I found the task, but I couldn't load the pull request diff, so I can't compare the implementation with it. Try ${RERUN} again.`;
}

export function judgeFailedMessage(): string {
    return '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.';
}

function listReferences(references: TaskReference[]): string {
    const raw = [...new Set(references.map((r) => `\`${r.raw}\``))];
    return raw.join(', ');
}
