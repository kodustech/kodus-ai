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
} as const;
