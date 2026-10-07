import type { Task } from '../business-validation.types';
import type { TaskQuality } from './validation.types';

const DEFAULT_USER_LANGUAGE = 'en-US';

export const TASK_QUALITY_ANALYZER_POLICY = `- EMPTY => needsMoreInfo = true
- MINIMAL => needsMoreInfo = true
- PARTIAL => proceed with full gap analysis
- COMPLETE => proceed with full gap analysis
- Never proceed using only PR description as task context.`;

export interface AnalysisPromptInput {
    task: Task;
    /** The task as the judge reads it (title, description, criteria). */
    taskText: string;
    taskQuality: TaskQuality;
    diff: string;
    unseenFiles?: string[];
    pullRequestBody?: string;
    userLanguage?: string;
}

export function buildBusinessRulesAnalysisPrompt(
    input: AnalysisPromptInput,
): string {
    const acceptanceCriteria = formatAcceptanceCriteria(input);
    const links = uniqueNonEmpty([
        ...(input.task.url ? [input.task.url] : []),
        ...extractLinksFromText(input.taskText),
    ]);
    const userLanguage =
        typeof input.userLanguage === 'string' &&
        input.userLanguage.trim().length > 0
            ? input.userLanguage
            : DEFAULT_USER_LANGUAGE;

    const sections: string[] = [
        'Perform business rules gap analysis.',
        '',
        `TASK_QUALITY: ${input.taskQuality}`,
        '',
        `TASK: ${[input.task.id, input.task.title].filter(Boolean).join(' — ')}`,
    ];

    if (links.length > 0) {
        sections.push('', 'TASK_LINKS:', links.join('\n'));
    }

    sections.push(
        '',
        'ACCEPTANCE_CRITERIA:',
        acceptanceCriteria,
        '',
        'FULL_TASK_CONTEXT:',
        formatPromptValue(input.taskText, '(none)'),
        '',
        'PR_DIFF:',
        formatPromptValue(input.diff, '(not available)'),
        ...(input.unseenFiles?.length
            ? [
                  '',
                  'FILES_NOT_SHOWN (changed in the PR, but too large to include):',
                  input.unseenFiles.join('\n'),
              ]
            : []),
        '',
        'PR_DESCRIPTION:',
        formatPromptValue(input.pullRequestBody, '(not available)'),
        '',
        `USER LANGUAGE: ${userLanguage}`,
        '',
        'TASK_QUALITY_POLICY:',
        TASK_QUALITY_ANALYZER_POLICY,
        '',
        'INSTRUCTIONS:',
        'List EVERY requirement of the task in `requirements`: each acceptance criterion, then any requirement of FULL_TASK_CONTEXT the criteria leave out. For each, set `state`: met, partial, missing, or check_manually (a visual or flow requirement the code cannot prove).',
        'Give `evidence` as file and line from PR_DIFF for met and partial, and for missing when a file shows the gap. Put what the code does or lacks in `note`, and the change to make in `action`.',
        'Set `confidence` per requirement: low when you are guessing. List changes the task does not ask for in `outOfScope`.',
        'Write `note`, `action`, `change`, `summary` and `missingInfo` in USER LANGUAGE. Quote `requirement` from the task as written.',
        'Follow the grounding rules from your system prompt. Submit the result with the submitValidation tool.',
    );

    return sections.join('\n');
}

function formatPromptValue(
    value: string | undefined,
    fallback: string,
): string {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : fallback;
}

function formatAcceptanceCriteria(input: AnalysisPromptInput): string {
    const criteria = input.task.acceptanceCriteria;

    if (criteria && criteria.length > 0) {
        return criteria.map((ac, i) => `${i + 1}. "${ac}"`).join('\n');
    }

    // Fallback: try to extract bullet points from raw task context
    const extracted = extractCriteriaFromText(input.taskText);
    if (extracted.length > 0) {
        return extracted
            .map(
                (ac, i) =>
                    `${i + 1}. "${ac}" (extracted from task description)`,
            )
            .join('\n');
    }

    return '(no structured acceptance criteria available — use FULL_TASK_CONTEXT to identify requirements)';
}

/**
 * Best-effort extraction of bullet-point requirements from raw task text.
 * Looks for common patterns: "- [ ] ...", "- ...", "* ...", numbered lists.
 */
function extractCriteriaFromText(text: string | undefined): string[] {
    if (!text || text.trim().length === 0) {
        return [];
    }

    const lines = text.split('\n');
    const criteria: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Match: "- [ ] something", "- [x] something", "- something", "* something", "1. something"
        const match = trimmed.match(
            /^(?:[-*]\s*(?:\[[ x]]\s*)?|\d+\.\s+)(.+)$/i,
        );
        if (match && match[1]) {
            const content = match[1].trim();
            if (isUrlOnlyItem(content)) {
                continue;
            }
            // Skip very short items (likely not requirements) and headers
            if (content.length > 10 && !content.startsWith('#')) {
                criteria.push(content);
            }
        }
    }

    return criteria;
}

function isUrlOnlyItem(value: string): boolean {
    const normalized = normalizeLikelyUrl(value);
    if (!normalized) {
        return false;
    }
    return /^https?:\/\/\S+$/i.test(normalized);
}

function extractLinksFromText(text: string | undefined): string[] {
    if (!text) {
        return [];
    }

    const links: string[] = [];
    for (const match of text.matchAll(/https?:\/\/[^\s)]+/gi)) {
        const normalized = normalizeLikelyUrl(match[0]);
        if (!normalized) {
            continue;
        }
        links.push(normalized);
    }

    return uniqueNonEmpty(links);
}

function normalizeLikelyUrl(value: string): string {
    return value
        .trim()
        .replace(/^[("'`<]+/g, '')
        .replace(/[)\]'",.;:!?]+$/g, '');
}

function uniqueNonEmpty(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
}
