import { EnrichedPullRequestResponse } from './enriched-pull-request-response.dto';

export class PaginationMetadata {
    currentPage: number;
    totalPages: number;
    // Execution rows matching the DB-level filters (a PR reviewed N times counts
    // N here). Drives page math; NOT the PR count shown in the header.
    totalItems: number;
    // Distinct PRs matching the DB-level filters — the accurate "N pull requests"
    // for the header. Undefined on error/empty responses. Does NOT reflect the
    // Mongo-side suggestion/author filters (applied post-query), so the client
    // only trusts it as exact when none of those are active.
    distinctPrTotal?: number;
    itemsPerPage: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
}

export class PaginatedEnrichedPullRequestsResponse {
    data: EnrichedPullRequestResponse[];
    pagination: PaginationMetadata;
}
