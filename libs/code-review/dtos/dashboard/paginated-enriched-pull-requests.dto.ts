import { EnrichedPullRequestResponse } from './enriched-pull-request-response.dto';

export class PaginationMetadata {
    currentPage: number;
    // The totals below are present only when the result is known to be empty.
    // Counting walks every matching execution, so the list does not do it;
    // GET /pull-requests/executions/totals answers the numbers on its own.
    totalPages?: number;
    // Execution rows matching the DB-level filters (a PR reviewed N times counts
    // N here). NOT the PR count shown in the header.
    totalItems?: number;
    // Distinct PRs matching the DB-level filters — the accurate "N pull requests"
    // for the header. Does NOT reflect the Mongo-side suggestion/author filters
    // (applied post-query), so the client only trusts it as exact when none of
    // those are active.
    distinctPrTotal?: number;
    itemsPerPage: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    // Resume point for the next page: the last execution this response READ,
    // which is past the last one it emitted whenever post-query filters dropped
    // rows. Clients must send it back as `cursor` instead of incrementing
    // `page` — see EnrichedPullRequestsQueryDto.cursor. Undefined when the
    // source is exhausted.
    nextCursor?: string;
}

export class PaginatedEnrichedPullRequestsResponse {
    data: EnrichedPullRequestResponse[];
    pagination: PaginationMetadata;
}

/** Answer of GET /pull-requests/executions/totals. */
export class PullRequestExecutionsTotals {
    // Execution rows matching the DB-level filters.
    totalItems: number;
    // Distinct PRs (repository + number) behind those executions.
    distinctPrTotal: number;
}
