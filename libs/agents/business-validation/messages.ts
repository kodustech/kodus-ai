import type {
    ResolutionAttempt,
    Task,
    TaskReference,
} from './business-validation.types';
import { referenceLabel } from './task-references';

/**
 * What the PR author reads. English here; the service rewrites it in the
 * team's language. Each message says what happened and what to do next.
 */

const RERUN = '`@kody -v business-logic`';

export function taskTooThinMessage(tasks: Task[]): string {
    const task = tasks[0];
    const others = tasks.slice(1).map((t) => `**${t.id}**`);
    return `## 🤔 ${task.id} ${task.description?.trim() ? 'says too little to check against' : 'has only a title'}

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

This pull request doesn't reference a task. Reference it in the title, description or branch (\`PROJ-123\`, \`#123\` or a link), or run ${RERUN} followed by the task id or link. A \`#123\` the description only mentions isn't read as the task: write \`Closes #123\`.`;
}

/** How to name the task, for every message that asks for one. */
const REFERENCE_A_TASK = `Reference the task in the title, description or branch (\`PROJ-123\`, \`Closes #123\` or a link) and comment ${RERUN}.`;

/** No task referenced, and the repository's settings ask for one. */
export function taskRequiredMessage(): string {
    return `## 🤔 Which task is this?

This pull request doesn't reference a task, and this repository asks for one so Kody can check the PR against it.

### 💡 Next step
${REFERENCE_A_TASK}`;
}

export function noTrackerMessage(
    /** The repository reads tasks from one chosen source, and it is gone. */
    sourceChosen = false,
): string {
    if (sourceChosen) {
        return `## 🤔 This repository's task source isn't connected

The Business Logic settings read tasks only from one source, and it is no longer connected (switching the Git provider removes Git Issues, for example). Reconnect it, or pick another source or "Every connected tracker" in the Business Logic settings.`;
    }
    return 'No task-management MCP (Jira, Git Issues, Linear, Notion, ClickUp, etc.) is connected for this organization, so business rules validation has nothing to compare the PR against. Connect one in the Kodus settings to use this command.';
}

export function noCapableTrackerMessage(
    references: TaskReference[],
    trackers: string[],
    /** The repository reads tasks from one chosen source, not every tracker. */
    sourceChosen = false,
): string {
    if (sourceChosen) {
        return `## 🤔 I can't read the referenced task

${listReferences(references)} can't be read by this repository's task source (${trackers.join(', ')}), and Kody asks no other tracker. In the Business Logic settings, pick the tracker where it lives or "Every connected tracker", or reference a task from ${trackers.join(', ')}.`;
    }
    return `## 🤔 I can't read the referenced task

${listReferences(references)} can't be read by the connected task tools (${trackers.join(', ')}). Connect the tracker where it lives, or reference a task from one of these.`;
}

export function noReadToolMessage(trackers: string[]): string {
    const names = trackers.join(', ');
    return `## 🤔 ${names} can't read a task yet

Kody reads tasks from ${names}, but no tool that reads one task by its id is picked. In the Business Logic settings, choose which ${names} tool reads a task, then comment ${RERUN}.`;
}

/**
 * What was looked for and where, once each. A tracker that couldn't read (no
 * tool picked) never said the task isn't there, so it is left out.
 */
function triedReferences(attempts: ResolutionAttempt[]): string[] {
    return [
        ...new Set(
            attempts
                .filter((a) => a.status === 'not_found')
                .map((a) => `${a.reference} in ${a.tracker}`),
        ),
    ];
}

export function taskNotFoundMessage(attempts: ResolutionAttempt[]): string {
    const tried = triedReferences(attempts);
    return `## 🤔 Task not found

I looked for ${tried.join(', ')}, and ${tried.length > 1 ? 'none of them exists' : "it doesn't exist there"}. Check the reference in the title, description or branch, then comment ${RERUN}.`;
}

/**
 * The repository asks for a task and none the PR names was found. What was
 * looked for can be a real key the tracker can't see (#2422) or a word that
 * only looks like one (`UTF-8`, a branch's `404`): the guidance to reference
 * the task comes first, the connection check only for a reference that is
 * the task.
 */
export function taskRequiredNotFoundMessage(
    attempts: ResolutionAttempt[],
): string {
    const tried = triedReferences(attempts);
    if (!tried.length) {
        return taskRequiredMessage();
    }
    return `## 🤔 Which task is this?

This repository asks for a task so Kody can check the PR against it, and none was found: I looked for ${tried.join(', ')}.

### 💡 Next step
${REFERENCE_A_TASK} If ${tried.length > 1 ? 'one of these is' : 'that is'} the task, check that the Kodus connection can see its project.`;
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

export function tooLargeForModelMessage(
    contextWindowTokens: number,
    /** The answer the call declares: the slot's `maxOutputTokens`, when it sets one. */
    answerTokens = 0,
): string {
    if (answerTokens * 2 >= contextWindowTokens) {
        return `## 🤔 The model's answer limit leaves no room for the code

The model that checks business logic may write up to ${answerTokens} tokens, and its input window is ${contextWindowTokens} tokens: the provider counts both against the window, so the task and this PR's changes don't fit beside the answer. Nothing was checked. Lower the max output tokens of that model in the Business Logic settings, or pick a model with a larger window.`;
    }
    return `## 🤔 Too large for the model

The task, the pull request description and this PR's changes don't fit the input window of the model that checks business logic (${contextWindowTokens} tokens): not one changed file fits beside the task. Nothing was checked. A model with a larger window in the Business Logic settings, or a shorter task, lets Kody read the code.`;
}

export function judgeFailedMessage(): string {
    return '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.';
}

function listReferences(references: TaskReference[]): string {
    const labels = [
        ...new Set(references.map((r) => `\`${referenceLabel(r)}\``)),
    ];
    return labels.join(', ');
}
