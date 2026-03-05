import { TASK_QUALITY_ANALYZER_POLICY } from './task-quality.rules';
import { BusinessRulesContext } from './types';

const DEFAULT_USER_LANGUAGE = 'en-US';

export function buildBusinessRulesAnalysisPrompt(
    ctx: BusinessRulesContext,
): string {
    const acceptanceCriteria = formatAcceptanceCriteria(ctx);
    const taskId = ctx.taskContextNormalized?.id;
    const taskTitle = ctx.taskContextNormalized?.title;
    const taskLinks = ctx.taskContextNormalized?.links ?? [];
    const userLanguage =
        typeof ctx.userLanguage === 'string' &&
        ctx.userLanguage.trim().length > 0
            ? ctx.userLanguage
            : DEFAULT_USER_LANGUAGE;

    const sections: string[] = [
        'Perform business rules gap analysis.',
        '',
        `TASK_QUALITY: ${ctx.taskQuality}`,
    ];

    if (taskId || taskTitle) {
        sections.push(
            '',
            `TASK: ${[taskId, taskTitle].filter(Boolean).join(' — ')}`,
        );
    }

    if (taskLinks.length > 0) {
        sections.push('', 'TASK_LINKS:', taskLinks.join('\n'));
    }

    sections.push(
        '',
        'ACCEPTANCE_CRITERIA:',
        acceptanceCriteria,
        '',
        'FULL_TASK_CONTEXT:',
        formatPromptValue(ctx.taskContext, '(none)'),
        '',
        'PR_DIFF:',
        formatPromptValue(ctx.prDiff, '(not available)'),
        '',
        'PR_DESCRIPTION:',
        formatPromptValue(ctx.prBody, '(not available)'),
        '',
        `USER LANGUAGE: ${userLanguage}`,
        '',
        'TASK_QUALITY_POLICY:',
        TASK_QUALITY_ANALYZER_POLICY,
        '',
        'INSTRUCTIONS:',
        'Check EACH acceptance criterion against the PR_DIFF. For each one, determine: IMPLEMENTED, MISSING, or PARTIAL.',
        'Then scan for any task requirements in FULL_TASK_CONTEXT not covered by the acceptance criteria list.',
        'Write ALL generated prose in USER LANGUAGE.',
        'Only requirement quotes copied from task context may remain in the original source language.',
        'Do not mix languages in headings, status labels, findings, explanations, or suggested actions.',
        'Follow the grounding rules and output format from your system prompt exactly. Return ONLY a JSON object.',
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

function formatAcceptanceCriteria(ctx: BusinessRulesContext): string {
    const criteria = ctx.taskContextNormalized?.acceptanceCriteria;

    if (criteria && criteria.length > 0) {
        return criteria.map((ac, i) => `${i + 1}. "${ac}"`).join('\n');
    }

    // Fallback: try to extract bullet points from raw task context
    const extracted = extractCriteriaFromText(ctx.taskContext);
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
            // Skip very short items (likely not requirements) and headers
            if (content.length > 10 && !content.startsWith('#')) {
                criteria.push(content);
            }
        }
    }

    return criteria;
}
