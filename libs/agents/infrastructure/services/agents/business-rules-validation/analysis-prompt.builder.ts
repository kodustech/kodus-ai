import { TASK_QUALITY_ANALYZER_POLICY } from './task-quality.rules';
import { BusinessRulesContext } from './types';

const DEFAULT_USER_LANGUAGE = 'en-US';

export function buildBusinessRulesAnalysisPrompt(
    ctx: BusinessRulesContext,
): string {
    const acceptanceCriteria = formatAcceptanceCriteria(ctx);
    const taskMetadata = resolveTaskMetadata(ctx);
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

    if (taskMetadata.id || taskMetadata.title) {
        sections.push(
            '',
            `TASK: ${[taskMetadata.id, taskMetadata.title]
                .filter(Boolean)
                .join(' — ')}`,
        );
    }

    if (taskMetadata.links.length > 0) {
        sections.push('', 'TASK_LINKS:', taskMetadata.links.join('\n'));
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

function resolveTaskMetadata(ctx: BusinessRulesContext): {
    id?: string;
    title?: string;
    links: string[];
} {
    const normalized = ctx.taskContextNormalized;
    const linksFromText = extractLinksFromText(ctx.taskContext);
    const links = uniqueNonEmpty([
        ...(normalized?.links ?? []),
        ...linksFromText,
    ]);

    return {
        id: normalized?.id ?? extractTaskIdFromText(ctx.taskContext),
        title: normalized?.title ?? extractTaskTitleFromText(ctx.taskContext),
        links,
    };
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

function extractTaskIdFromText(text: string | undefined): string | undefined {
    if (!text) {
        return undefined;
    }

    const explicit = text.match(
        /\b(?:task|ticket|issue)\s*(?:id|key)\s*[:#-]?\s*([A-Z][A-Z0-9]+-\d+|\d+)\b/i,
    );
    if (explicit?.[1]) {
        return explicit[1].trim();
    }

    const issueKey = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    return issueKey?.[1];
}

function extractTaskTitleFromText(
    text: string | undefined,
): string | undefined {
    if (!text) {
        return undefined;
    }

    const match = text.match(/(?:^|\n)\s*title\s*:\s*(.+)$/im);
    if (!match?.[1]) {
        return undefined;
    }

    const title = match[1].trim();
    return title.length > 0 ? title : undefined;
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
