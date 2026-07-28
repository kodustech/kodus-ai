import { pathToApiUrl } from "src/core/utils/helpers";

export interface PullRequestFilters {
    teamId?: string;
    repositoryId?: string;
    repositoryName?: string;
    limit?: number;
    page?: number;
    pullRequestTitle?: string;
    pullRequestNumber?: string;
    hasSentSuggestions?: boolean;
    authorPolicy?: "all" | "reviewable" | "excluded";
    status?: PullRequestStatusFilter;
    createdAtFrom?: string;
    createdAtTo?: string;
    severity?: PullRequestSeverityFilter;
    category?: string;
    needsAttention?: boolean;
    author?: string;
}

export type PullRequestSeverityFilter = "critical" | "high" | "medium" | "low";

export type PullRequestStatusFilter =
    | "success"
    | "error"
    | "partial_error"
    | "skipped"
    | "in_progress"
    | "pending";

export const PULL_REQUEST_SSE = {
    EXECUTION_EVENTS: pathToApiUrl("/pull-requests/executions/events"),
};

export const PULL_REQUEST_API = {
    GET_EXECUTIONS: (filters?: PullRequestFilters) => {
        const params = new URLSearchParams();

        if (filters?.teamId) params.append("teamId", filters.teamId);
        if (filters?.repositoryId)
            params.append("repositoryId", filters.repositoryId);
        if (filters?.repositoryName)
            params.append("repositoryName", filters.repositoryName);
        if (filters?.limit) params.append("limit", filters.limit.toString());
        if (filters?.page) params.append("page", filters.page.toString());
        if (filters?.pullRequestTitle)
            params.append("pullRequestTitle", filters.pullRequestTitle);
        if (filters?.pullRequestNumber)
            params.append("pullRequestNumber", filters.pullRequestNumber);
        if (typeof filters?.hasSentSuggestions === "boolean")
            params.append(
                "hasSentSuggestions",
                filters.hasSentSuggestions.toString(),
            );
        if (filters?.authorPolicy) {
            params.append("authorPolicy", filters.authorPolicy);
        }
        if (filters?.status) {
            params.append("status", filters.status);
        }
        if (filters?.createdAtFrom)
            params.append("createdAtFrom", filters.createdAtFrom);
        if (filters?.createdAtTo)
            params.append("createdAtTo", filters.createdAtTo);
        if (filters?.severity) {
            params.append("severity", filters.severity);
        }
        if (filters?.category) {
            params.append("category", filters.category);
        }
        if (filters?.needsAttention) {
            params.append("needsAttention", "true");
        }
        if (filters?.author) {
            params.append("author", filters.author);
        }

        const queryString = params.toString();
        return pathToApiUrl(
            `/pull-requests/executions${queryString ? `?${queryString}` : ""}`,
        );
    },
    GET_DAILY_DIGEST: (teamId?: string) => {
        const params = new URLSearchParams();
        if (teamId) params.append("teamId", teamId);
        const queryString = params.toString();
        return pathToApiUrl(
            `/pull-requests/executions/summary${queryString ? `?${queryString}` : ""}`,
        );
    },
    GET_FACETS: (teamId?: string, scope?: "mine" | "team") => {
        const params = new URLSearchParams();
        if (teamId) params.append("teamId", teamId);
        // Only send the non-default scope so the "team" facet keeps a stable
        // cache key / URL.
        if (scope === "mine") params.append("scope", "mine");
        const queryString = params.toString();
        return pathToApiUrl(
            `/pull-requests/executions/facets${queryString ? `?${queryString}` : ""}`,
        );
    },
    GET_AWAITING: (teamId?: string) => {
        const params = new URLSearchParams();
        if (teamId) params.append("teamId", teamId);
        const queryString = params.toString();
        return pathToApiUrl(
            `/pull-requests/awaiting${queryString ? `?${queryString}` : ""}`,
        );
    },
    GET_AUTHORS: (teamId?: string, q?: string, limit?: number) => {
        const params = new URLSearchParams();
        if (teamId) params.append("teamId", teamId);
        if (q?.trim()) params.append("q", q.trim());
        if (limit) params.append("limit", String(limit));
        const queryString = params.toString();
        return pathToApiUrl(
            `/pull-requests/authors${queryString ? `?${queryString}` : ""}`,
        );
    },
    GET_SUGGESTIONS: (params: {
        repositoryId: string;
        prNumber: number;
        severity?: string;
        category?: string;
    }) => {
        const searchParams = new URLSearchParams();
        searchParams.append("repositoryId", params.repositoryId);
        searchParams.append("prNumber", params.prNumber.toString());
        if (params.severity) searchParams.append("severity", params.severity);
        if (params.category) searchParams.append("category", params.category);
        return pathToApiUrl(
            `/pull-requests/suggestions?${searchParams.toString()}`,
        );
    },
    GET_FILES: (params: {
        repositoryId: string;
        prNumber: number;
        teamId: string;
        repositoryName?: string;
    }) => {
        const searchParams = new URLSearchParams();
        searchParams.append("repositoryId", params.repositoryId);
        searchParams.append("prNumber", params.prNumber.toString());
        searchParams.append("teamId", params.teamId);
        if (params.repositoryName)
            searchParams.append("repositoryName", params.repositoryName);
        return pathToApiUrl(`/pull-requests/files?${searchParams.toString()}`);
    },
} as const;
