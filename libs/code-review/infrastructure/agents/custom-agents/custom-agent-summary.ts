import type {
    CodeSuggestion,
    CommentResult,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';

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
        | 'ran'
        | 'no-matching-files'
        | 'ignored-paths'
        | 'deleted-files'
        | 'failed'
        | 'incomplete';
    /** Findings the checks refuted: the verify pass (or could not judge),
     *  and the quote check on rules the finding claimed to cite. Shown as
     *  "Dropped by checks", since both reasons count here. */
    droppedByVerify: number;
}

export interface CustomAgentRunSummary extends CustomAgentRun {
    posted: number;
    /** Kept findings under the review's minimum severity: not posted, and
     *  without this count the agent read "0 posted, 0 dropped". */
    belowSeverity?: number;
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
        /** Deleted files, which the review sets aside with the ignored ones. */
        removedFiles?: readonly string[];
    },
    /** Findings the review set aside, the severity filter's among them. */
    discarded: ReadonlyArray<Partial<CodeSuggestion>> = [],
): CustomAgentRunSummary[] {
    return (runs ?? []).map((run) => {
        const belowSeverity = discarded.filter(
            (s) =>
                s.customAgent?.id === run.id &&
                s.priorityStatus === PriorityStatus.DISCARDED_BY_SEVERITY,
        ).length;
        return {
            ...run,
            status: notRunReason(run, ignored),
            posted: posted.filter((s) => s.customAgent?.id === run.id).length,
            ...(belowSeverity > 0 && { belowSeverity }),
        };
    });
}

/**
 * "Posted" as the pull request got it: the summary is built before anything
 * is posted, so a provider that refused every comment still read "8 posted"
 * next to "no issues found". An inline agent counts its sent comments; a
 * single-comment agent counts its findings only when that comment was sent.
 * Without delivery results the counts stay as they were.
 */
export function withDeliveredCounts(
    runs: readonly CustomAgentRunSummary[] | undefined,
    lineComments: readonly CommentResult[] | undefined,
    prLevelComments: readonly CommentResult[] | undefined,
): CustomAgentRunSummary[] {
    if (!lineComments && !prLevelComments) return [...(runs ?? [])];
    const agentOf = (r: CommentResult) =>
        (r?.comment as { suggestion?: Partial<CodeSuggestion> } | undefined)
            ?.suggestion?.customAgent?.id;
    const sent = (r: CommentResult) =>
        r?.deliveryStatus === DeliveryStatus.SENT;
    return (runs ?? []).map((run) => {
        const inline = (lineComments ?? []).filter(
            (r) => agentOf(r) === run.id,
        );
        if (inline.length) {
            return { ...run, posted: inline.filter(sent).length };
        }
        const single = (prLevelComments ?? []).filter(
            (r) => agentOf(r) === run.id,
        );
        if (single.length) {
            return { ...run, posted: single.some(sent) ? run.posted : 0 };
        }
        return { ...run, posted: run.posted > 0 ? 0 : run.posted };
    });
}

/**
 * Why an agent whose scope matched no reviewed file did not run: its files
 * were all deleted, or some are in the ignored paths. The review sets deleted
 * files aside with the ignored ones, so they are told apart here.
 */
function notRunReason(
    run: CustomAgentRun,
    ignored:
        | {
              agents: ReadonlyArray<Pick<CustomAgentConfig, 'id' | 'scope'>>;
              ignoredFiles: readonly string[];
              removedFiles?: readonly string[];
          }
        | undefined,
): CustomAgentRun['status'] {
    if (run.status !== 'no-matching-files' || !ignored?.ignoredFiles.length) {
        return run.status;
    }
    const agent = ignored.agents.find((a) => a.id === run.id);
    if (!agent) {
        return run.status;
    }
    const inScope = filesInAgentScope(
        agent,
        ignored.ignoredFiles.map((filename) => ({ filename })),
    );
    if (!inScope.length) {
        return run.status;
    }
    const removed = new Set(ignored.removedFiles ?? []);
    return inScope.every((f) => removed.has(f.filename))
        ? 'deleted-files'
        : 'ignored-paths';
}

const STATUS_TEXT: Record<CustomAgentRun['status'], string> = {
    'ran': 'ran',
    'no-matching-files': 'not run: no matching files',
    'ignored-paths': 'not run: its files are in the ignored paths',
    'deleted-files': 'not run: its files were deleted',
    'failed': 'failed',
    'incomplete': 'incomplete',
};

/** Why an agent did not run, for the one line that lists those agents. */
const NOT_RUN_REASON: Partial<Record<CustomAgentRun['status'], string>> = {
    'no-matching-files': 'no matching files',
    'ignored-paths': 'its files are in the ignored paths',
    'deleted-files': 'its files were deleted',
};

const escapeCell = (text: string): string =>
    text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * Markdown section for the end-review comment; empty when no agent was
 * configured. Agents that ran (or failed) get a row; those that did not run
 * are listed by name on one line per reason, so thirty configured agents do
 * not make a thirty-row table for the two that ran.
 */
export function formatCustomAgentsSummary(
    runs: readonly CustomAgentRunSummary[] | undefined,
): string {
    if (!runs?.length) {
        return '';
    }
    // The column shows only when a finding was held back by severity, so the
    // usual table stays as it was.
    const withSeverity = runs.some((r) => (r.belowSeverity ?? 0) > 0);
    const rows = runs
        .filter((r) => !NOT_RUN_REASON[r.status])
        .map(
            (r) =>
                `| ${escapeCell(r.name)} | ${STATUS_TEXT[r.status]} | ${r.posted} | ${r.droppedByVerify} |${withSeverity ? ` ${r.belowSeverity ?? 0} |` : ''}`,
        );
    const notRun = new Map<string, string[]>();
    for (const r of runs) {
        const reason = NOT_RUN_REASON[r.status];
        if (reason) {
            notRun.set(reason, [...(notRun.get(reason) ?? []), r.name]);
        }
    }
    const notRunLines = [...notRun].map(
        ([reason, names]) =>
            `Not run: ${names.map((n) => n.replace(/\r?\n/g, ' ')).join(', ')} (${reason})`,
    );
    const table = rows.length
        ? [
              withSeverity
                  ? '| Agent | Status | Posted | Dropped by checks | Below minimum severity |'
                  : '| Agent | Status | Posted | Dropped by checks |',
              withSeverity
                  ? '| --- | --- | --- | --- | --- |'
                  : '| --- | --- | --- | --- |',
              ...rows,
          ]
        : [];
    return [
        '',
        '',
        '<details>',
        '<summary>Custom agents</summary>',
        '',
        ...table,
        ...(table.length && notRunLines.length ? [''] : []),
        ...notRunLines.flatMap((line, i) => (i ? ['', line] : [line])),
        '',
        '</details>',
    ].join('\n');
}
