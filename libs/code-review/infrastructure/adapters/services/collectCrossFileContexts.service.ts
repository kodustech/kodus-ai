/**
 * Cross-file-context shared types.
 *
 * The CollectCrossFileContextsService (LLM planner + search executor) and its
 * CodebaseSearchService dependency were removed: they were the pre-agent
 * implementation of cross-file context, wired into a pipeline stage that was
 * retired in caf62b7f9 when the review moved to the agent-first path (the agent
 * gathers cross-file context via its own grep/readFile tools). The service was
 * left as a registered-but-never-injected zombie provider — reachability audit
 * confirmed collectContexts() had zero callers.
 *
 * Only these types survive: they are still referenced by live code
 * (RemoteCommands by the agent native-tools/sandbox/documentation services,
 * CrossFileContextSnippet + the result shape by the review pipeline), so the
 * module keeps the historical file path to avoid churning their ~20 import sites.
 */
import { CrossFileContextPlannerSchemaType } from '@libs/common/utils/prompts/codeReviewCrossFileContextPlanner';

/**
 * Remote command executors for sandbox environments.
 * Abstracts shell commands executed in remote sandbox environments (E2B).
 */
export interface RemoteCommands {
    grep: (pattern: string, path: string, glob?: string) => Promise<string>;
    read: (path: string, start: number, end: number) => Promise<string>;
    listDir: (path: string, maxDepth: number) => Promise<string>;
    /**
     * Run an arbitrary read-only shell command in the sandbox.
     * stdout and stderr are returned SEPARATELY (not merged) so consumers can
     * distinguish real output from error/diagnostic text and gate on exitCode.
     */
    exec?: (
        command: string,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export type CrossFileContextSnippet = {
    filePath: string;
    content: string;
    rationale: string;
    relevanceScore: number;
    relatedSymbol?: string;
    relationship: string;
    hop: number;
    riskLevel: 'low' | 'medium' | 'high';
    startLine?: number;
    endLine?: number;
    targetFiles?: string[];
};

export type CollectCrossFileContextsResult = {
    contexts: CrossFileContextSnippet[];
    plannerQueries: CrossFileContextPlannerSchemaType['queries'];
    totalSearches: number;
    totalSnippetsBeforeDedup: number;
};
