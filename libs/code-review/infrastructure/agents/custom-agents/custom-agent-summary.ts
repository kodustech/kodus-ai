import type {
    CodeSuggestion,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { filesInAgentScope } from './custom-agent-scope';

/**
 * What each custom agent did on a review (#2172), for the outcome log line.
 * The orchestrator records whether it ran; the stage adds what it kept.
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
     *  and the quote check on rules the finding claimed to cite. */
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
        /** Deleted files, which the review sets aside with the ignored ones. */
        removedFiles?: readonly string[];
    },
): CustomAgentRunSummary[] {
    const postedBy = new Map<string, number>();
    for (const s of posted) {
        const id = s.customAgent?.id;
        if (id) postedBy.set(id, (postedBy.get(id) ?? 0) + 1);
    }
    return (runs ?? []).map((run) => ({
        ...run,
        status: notRunReason(run, ignored),
        posted: postedBy.get(run.id) ?? 0,
    }));
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
