import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

import type { PullRequestExecutionsPayload } from "./types";

export interface PullRequestFilters {
    teamId?: string;
    repositoryId?: string;
    repositoryName?: string;
    limit?: number;
    page?: number;
    // Resume point echoed back from `pagination.nextCursor`. Preferred over
    // `page`: a page consumes more executions than it returns whenever a
    // post-query filter drops rows, so a page-number offset lands inside the
    // window the previous page already served.
    cursor?: string;
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
    /** The PR's own state — not `status`, which is Kody's review run. */
    prState?: "open" | "closed";
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
        if (filters?.cursor) params.append("cursor", filters.cursor);
        else if (filters?.page) params.append("page", filters.page.toString());
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
        if (filters?.prState) {
            params.append("prState", filters.prState);
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

/**
 * How many distinct pull requests Kody reviewed for a team since a date.
 *
 * Server-side counterpart of the Reviews list: it asks for a single row and
 * reads `pagination.distinctPrTotal`, the total the backend computes for the
 * filters. Used by gated screens that want to say what the org already has
 * instead of showing invented sample numbers — every viewer who sees this
 * count can already read the same PRs on /pull-requests, so it leaks nothing.
 *
 * Returns `null` when the count can't be established (no team, request
 * failed, older payload shape without a total), so callers can fall back to
 * copy that claims no numbers at all.
 */
export const getReviewedPullRequestCount = async ({
    teamId,
    windowDays,
}: {
    teamId?: string;
    /** Look back this many days; omit to count every review ever run. */
    windowDays?: number;
}): Promise<number | null> => {
    if (!teamId) return null;

    const since = windowDays
        ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
        : undefined;

    try {
        const payload = await authorizedFetch<PullRequestExecutionsPayload>(
            PULL_REQUEST_API.GET_EXECUTIONS({
                teamId,
                limit: 1,
                createdAtFrom: since?.toISOString(),
            }),
            { cache: "no-store" },
        );

        if (!payload || Array.isArray(payload)) return null;

        // `distinctPrTotal` is the accurate count, but the backend omits it
        // when there is nothing to count — a workspace with no reviews comes
        // back as `{ data: [], pagination: { totalItems: 0 } }`. Falling back
        // to `totalItems` is what tells "none yet" apart from "couldn't ask",
        // and those two lead to different screens.
        const { distinctPrTotal, totalItems } = payload.pagination ?? {};
        if (typeof distinctPrTotal === "number") return distinctPrTotal;
        if (typeof totalItems === "number") return totalItems;
        return null;
    } catch {
        return null;
    }
};
