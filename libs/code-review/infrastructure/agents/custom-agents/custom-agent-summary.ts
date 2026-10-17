import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * What each custom agent did on a review (#2172), for the end-review comment.
 * The orchestrator records whether it ran; the stage adds what reached the PR.
 */
export interface CustomAgentRun {
    id: string;
    name: string;
    slug: string;
    status: 'ran' | 'no-matching-files' | 'failed' | 'incomplete';
    /** Findings the verify pass refuted (or could not judge). */
    droppedByVerify: number;
}

export interface CustomAgentRunSummary extends CustomAgentRun {
    posted: number;
}

/** Joins the orchestrator's runs with the findings the review kept for each agent. */
export function summarizeCustomAgentRuns(
    runs: readonly CustomAgentRun[] | undefined,
    /** Findings that will post: inline, or gathered in a single comment. */
    posted: ReadonlyArray<Partial<CodeSuggestion>>,
): CustomAgentRunSummary[] {
    return (runs ?? []).map((run) => ({
        ...run,
        posted: posted.filter((s) => s.customAgent?.id === run.id).length,
    }));
}

const STATUS_TEXT: Record<CustomAgentRun['status'], string> = {
    'ran': 'ran',
    'no-matching-files': 'not run: no matching files',
    'failed': 'failed',
    'incomplete': 'incomplete',
};

const escapeCell = (text: string): string =>
    text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Markdown section for the end-review comment; empty when no agent was configured. */
export function formatCustomAgentsSummary(
    runs: readonly CustomAgentRunSummary[] | undefined,
): string {
    if (!runs?.length) {
        return '';
    }
    const rows = runs.map(
        (r) =>
            `| ${escapeCell(r.name)} | ${STATUS_TEXT[r.status]} | ${r.posted} | ${r.droppedByVerify} |`,
    );
    return [
        '',
        '',
        '<details>',
        '<summary>Custom agents</summary>',
        '',
        '| Agent | Status | Posted | Dropped by verification |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
        '</details>',
    ].join('\n');
}
