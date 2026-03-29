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
}

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

        const queryString = params.toString();
        return pathToApiUrl(
            `/pull-requests/executions${queryString ? `?${queryString}` : ""}`,
        );
    },
    GET_ONBOARDING_SIGNALS: (filters: {
        teamId: string;
        repositoryIds: string[];
        limit?: number;
    }) => {
        const params = new URLSearchParams();
        if (filters.teamId) params.append("teamId", filters.teamId);
        (filters.repositoryIds || []).forEach((id) =>
            params.append("repositoryIds", id),
        );
        if (filters.limit) params.append("limit", String(filters.limit));

        const queryString = params.toString();
        return pathToApiUrl(
            `/pull-requests/onboarding-signals${queryString ? `?${queryString}` : ""}`,
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
