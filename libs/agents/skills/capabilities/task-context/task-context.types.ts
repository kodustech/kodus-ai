/**
 * task-context — shared types.
 *
 * Extracted from the task-context-read monolith so the read orchestrator and the
 * arg-building module can share these contracts without a circular import.
 */
import type { AgentThread } from '../../runtime/skill-runtime.types';

export type ResolutionMode = 'cache_first' | 'agent_first';

export interface TaskContextSignalHints {
    ticketKeys?: string[];
    taskLinks?: string[];
    requirementKeywords?: string[];
}

export interface TaskContextReadParams {
    skillName: string;
    organizationId: string;
    teamId: string;
    repositoryOwner?: string;
    repositoryName?: string;
    pullRequestNumber?: number;
    prBody?: string;
    headRef?: string;
    userQuestion?: string;
    pullRequestDescription?: string;
    taskContext?: string;
    taskId?: string;
    taskUrl?: string;
    taskReference?: string;
    userLanguage?: string;
    thread?: AgentThread;
    excludedTools?: string[];
    taskContextResolutionMode?: ResolutionMode;
    enableAgenticFallback?: boolean;
    businessSignals?: TaskContextSignalHints;
}

/** Reference signals mined from PR/task text, used to build tool args. */
export interface TaskContextHints {
    issueKeys: string[];
    issueNumbers: number[];
    issueLinks: string[];
    explicitIssueKeys: string[];
    explicitIssueLinks: string[];
    queryText: string;
    urlHosts: string[];
    siteUrls: string[];
    resourceIds: string[];
}

/** A task-context MCP tool's input schema, normalized for matching. */
export interface TaskContextToolSignature {
    requiredParams: string[];
    properties: Record<string, Record<string, unknown>>;
    normalizedProperties: Record<string, Record<string, unknown>>;
}
