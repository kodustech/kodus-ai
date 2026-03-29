import {
    BusinessLogicEligibility,
    PrDiffStatus,
    TaskContextNormalized,
    TaskContextStatus,
    TaskQuality,
} from './types';

const ANALYZABLE_TASK_QUALITIES: ReadonlySet<TaskQuality> = new Set([
    'PARTIAL',
    'COMPLETE',
]);

export function normalizeTaskQuality(value: unknown): TaskQuality {
    if (
        value === 'EMPTY' ||
        value === 'MINIMAL' ||
        value === 'PARTIAL' ||
        value === 'COMPLETE'
    ) {
        return value;
    }
    return 'EMPTY';
}

export function canProceedWithBusinessRulesAnalysis(
    taskQuality: TaskQuality | undefined,
): boolean {
    return ANALYZABLE_TASK_QUALITIES.has(normalizeTaskQuality(taskQuality));
}

export function hasUsablePullRequestDiff(prDiff: string | undefined): boolean {
    return typeof prDiff === 'string' && prDiff.trim().length > 0;
}

export function classifyTaskContextStatus(input: {
    taskQuality: TaskQuality | undefined;
    taskContext?: string;
    taskContextNormalized?: TaskContextNormalized;
}): TaskContextStatus {
    const quality = normalizeTaskQuality(input.taskQuality);
    if (quality === 'EMPTY') {
        return 'missing';
    }

    if (quality === 'MINIMAL') {
        return 'weak';
    }

    const description =
        input.taskContextNormalized?.description ?? input.taskContext ?? '';
    if (looksLikeStructuredMetadata(description)) {
        return 'weak';
    }
    if (looksLikeTaskFetchFailure(description)) {
        return 'weak';
    }

    return 'usable';
}

export function classifyPrDiffStatus(prDiff: string | undefined): PrDiffStatus {
    return hasUsablePullRequestDiff(prDiff) ? 'usable' : 'missing';
}

export function buildBusinessLogicEligibility(input: {
    taskQuality: TaskQuality | undefined;
    taskContext?: string;
    taskContextNormalized?: TaskContextNormalized;
    prDiff?: string;
}): BusinessLogicEligibility {
    const taskContextStatus = classifyTaskContextStatus({
        taskQuality: input.taskQuality,
        taskContext: input.taskContext,
        taskContextNormalized: input.taskContextNormalized,
    });
    const prDiffStatus = classifyPrDiffStatus(input.prDiff);

    if (taskContextStatus === 'missing') {
        return {
            mode: 'limitation_response',
            reason: 'task_context_missing',
            taskContextStatus,
            prDiffStatus,
        };
    }

    if (taskContextStatus === 'weak') {
        return {
            mode: 'limitation_response',
            reason: 'task_context_weak',
            taskContextStatus,
            prDiffStatus,
        };
    }

    if (prDiffStatus === 'missing') {
        return {
            mode: 'limitation_response',
            reason: 'pr_diff_missing',
            taskContextStatus,
            prDiffStatus,
        };
    }

    return {
        mode: 'full_analysis',
        reason: 'analysis_ready',
        taskContextStatus,
        prDiffStatus,
    };
}

export function getTaskContextMissingInfoMessage(
    taskQuality: TaskQuality | undefined,
): string {
    const quality = normalizeTaskQuality(taskQuality);
    if (quality === 'MINIMAL') {
        return buildMinimalContextMessage();
    }
    if (quality === 'EMPTY') {
        return buildEmptyContextMessage();
    }
    return buildWeakContextMessage();
}

export function getPullRequestDiffMissingInfoMessage(): string {
    return `## 🤔 Need Pull Request Diff

I found enough task context to understand the expected behavior, but I couldn't load the pull request diff. Without the actual code changes, I can't validate whether the implementation matches the business requirements.

### 🔍 What I need to validate:
- The files and code paths changed in this PR
- The exact implementation compared to the task requirements
- Any regressions or missing business-rule coverage

### 💡 How to fix it:
- Ensure the PR diff tool is available and returns the patch content
- Retry the validation after the pull request diff is fetched successfully

### ⚠️ Important:
Business rules validation requires both the task context and the code diff.`;
}

export const TASK_QUALITY_CLASSIFICATION_GUIDE =
    'EMPTY (no task found), MINIMAL (title only), PARTIAL (some description), COMPLETE (description + acceptance criteria)';

export const TASK_QUALITY_ANALYZER_POLICY = `- EMPTY => needsMoreInfo = true
- MINIMAL => needsMoreInfo = true
- PARTIAL => proceed with full gap analysis
- COMPLETE => proceed with full gap analysis
- Never proceed using only PR description as task context.`;

function buildEmptyContextMessage(): string {
    return `## 🤔 Need Task Information

I couldn't find any task information associated with this pull request. To perform a proper business rules validation, I need context about what this PR is supposed to implement.

### 🔍 What I need to validate:
- Task title and description
- Acceptance criteria or business requirements
- Expected behavior and business rules

### 💡 Examples of how to provide it:
- Link a Jira/Linear/GitHub issue in the PR description
- Add a task URL in the PR body
- Include acceptance criteria directly in the PR description

### ⚠️ Important:
Business rules validation requires understanding **what** should be implemented, not just **what** was changed.`;
}

function buildMinimalContextMessage(): string {
    return `## 🤔 Insufficient Task Context

I found a task linked to this PR, but it only contains minimal information (title only, no description or acceptance criteria). To perform a meaningful business rules validation, I need more details.

### 🔍 What I need to validate:
- Business requirements and acceptance criteria
- Expected behavior and business rules
- Edge cases and constraints to consider

### 💡 How to improve the task context:
- Add a description to the linked ticket
- Include acceptance criteria or business rules
- Describe the expected behavior after the change

### ⚠️ Important:
A task title alone is not sufficient to determine whether the implementation is correct or complete.`;
}

function buildWeakContextMessage(): string {
    return `## 🤔 Limited Task Context

I found task-related information for this pull request, but the available context is still too weak or too ambiguous to support a reliable business rules validation.

### 🔍 What I still need to validate:
- Explicit business requirements or acceptance criteria
- Expected behavior and scope boundaries
- Enough detail to compare intended behavior against the PR diff

### 💡 How to improve the task context:
- Link the canonical Jira/Linear/GitHub issue instead of only a smart link or metadata card
- Add a clear task description and acceptance criteria
- Include the expected behavior directly in the PR description when the task is incomplete

### ⚠️ Important:
Without grounded requirement details, any business-rules finding would be speculative.`;
}

function looksLikeStructuredMetadata(value: string): boolean {
    const trimmed = value.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        return false;
    }

    return (
        trimmed.includes('"inlineCard"') ||
        trimmed.includes('"blockCard"') ||
        trimmed.includes('"application"') ||
        trimmed.includes('"attrs"') ||
        trimmed.includes('"url"')
    );
}

function looksLikeTaskFetchFailure(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    const hasErrorMarkers =
        normalized.includes('"error":true') ||
        normalized.includes('failed to fetch') ||
        /status:\s*\d{3}/i.test(value);

    if (!hasErrorMarkers) {
        return false;
    }

    return (
        normalized.includes('tenant info') ||
        normalized.includes('task context') ||
        normalized.includes('cloud id') ||
        normalized.includes('jira') ||
        normalized.includes('linear')
    );
}
