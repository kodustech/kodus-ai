/**
 * One review run of a pull request, as /pull-requests/executions returns it
 * (EnrichedPullRequestResponse in libs/code-review/dtos/dashboard). Only the
 * fields the CLI reads are typed; the rest passes through to --json untouched.
 */
export interface PullRequestReviewRun {
    prNumber: number;
    title: string;
    status: string;
    merged: boolean;
    url: string;
    repositoryName: string;
    repositoryId: string;
    author?: { id: string; username: string; name?: string };
    suggestionsCount?: {
        sent: number;
        filtered: number;
        bySeverity?: Record<string, number>;
        categories?: string[];
    };
    reviewedCommitSha?: string;
    executionId?: string;
    automationExecution?: {
        uuid: string;
        status: string;
        errorMessage?: string;
        createdAt: string;
        updatedAt: string;
        origin: string;
    };
    codeReviewTimeline?: Array<{
        status: string;
        stageName?: string;
        stageLabel?: string;
        message?: string | null;
    }>;
    [key: string]: unknown;
}

export interface PullRequestExecutionsPage {
    data: PullRequestReviewRun[];
    pagination: {
        currentPage: number;
        // Sent only when the request asks for them (`includeTotal=true`); the
        // list no longer counts by default. Paging reads `nextCursor`.
        totalPages?: number;
        totalItems?: number;
        hasNextPage: boolean;
        nextCursor?: string;
    };
}

export interface PullRequestExecutionsQuery {
    teamId: string;
    repositoryId?: string;
    repositoryName?: string;
    pullRequestNumber: number;
    limit?: number;
    cursor?: string;
}
