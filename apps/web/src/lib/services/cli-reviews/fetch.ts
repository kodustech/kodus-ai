import { pathToApiUrl } from "src/core/utils/helpers";

export interface CliReviewFilters {
    teamId?: string;
    repositoryId?: string;
    userEmail?: string;
    since?: string;
    page?: number;
    pageSize?: number;
}

export const CLI_REVIEWS_API = {
    LIST: (filters?: CliReviewFilters) => {
        const params = new URLSearchParams();
        if (filters?.teamId) params.append("teamId", filters.teamId);
        if (filters?.repositoryId)
            params.append("repositoryId", filters.repositoryId);
        if (filters?.userEmail) params.append("userEmail", filters.userEmail);
        if (filters?.since) params.append("since", filters.since);
        if (filters?.page) params.append("page", String(filters.page));
        if (filters?.pageSize)
            params.append("pageSize", String(filters.pageSize));

        const queryString = params.toString();
        return pathToApiUrl(
            `/cli-reviews/executions${queryString ? `?${queryString}` : ""}`,
        );
    },
    DETAIL: (executionUuid: string) =>
        pathToApiUrl(`/cli-reviews/${encodeURIComponent(executionUuid)}`),
};
