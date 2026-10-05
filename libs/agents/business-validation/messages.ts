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

export function taskTooThinMessage(task: Task): string {
    return `## 🤔 ${task.id} has only a title

I read **${task.id}** in ${task.tracker}, but it doesn't say what "done" means, so there is nothing to compare this pull request with.

### 💡 Next step
Add a description or acceptance criteria to ${task.id} and comment ${RERUN}.`;
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
