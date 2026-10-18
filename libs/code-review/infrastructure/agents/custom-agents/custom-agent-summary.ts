import type {
    CodeSuggestion,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { filesInAgentScope } from './custom-agent-scope';

/**
 * What each custom agent did on a review (#2172), for the end-review comment.
 * The orchestrator records whether it ran; the stage adds what reached the PR.
 */
export interface CustomAgentRun {
    id: string;
    name: string;
    slug: string;
    status:
        'ran' | 'no-matching-files' | 'ignored-paths' | 'failed' | 'incomplete';
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
    /** The review's ignored files: an agent with none of its files left to
     *  review is told apart from one whose scope matched nothing. */
    ignored?: {
        agents: ReadonlyArray<Pick<CustomAgentConfig, 'id' | 'scope'>>;
        ignoredFiles: readonly string[];
    },
): CustomAgentRunSummary[] {
    return (runs ?? []).map((run) => ({
        ...run,
        status: lostToIgnoredPaths(run, ignored) ? 'ignored-paths' : run.status,
        posted: posted.filter((s) => s.customAgent?.id === run.id).length,
    }));
}

function lostToIgnoredPaths(
    run: CustomAgentRun,
    ignored:
        | {
              agents: ReadonlyArray<Pick<CustomAgentConfig, 'id' | 'scope'>>;
              ignoredFiles: readonly string[];
          }
        | undefined,
): boolean {
    if (run.status !== 'no-matching-files' || !ignored?.ignoredFiles.length) {
        return false;
    }
    const agent = ignored.agents.find((a) => a.id === run.id);
    return (
        !!agent &&
        filesInAgentScope(
            agent,
            ignored.ignoredFiles.map((filename) => ({ filename })),
        ).length > 0
    );
}

const STATUS_TEXT: Record<CustomAgentRun['status'], string> = {
    'ran': 'ran',
    'no-matching-files': 'not run: no matching files',
    'ignored-paths': 'not run: its files are in the ignored paths',
    'failed': 'failed',
    'incomplete': 'incomplete',
};

const escapeCell = (text: string): string =>
    text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

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
