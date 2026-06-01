export type CliReviewStatus =
    | "in_progress"
    | "success"
    | "error"
    | "skipped"
    | "partial_error"
    | "pending";

export interface CliReviewTimelineItem {
    uuid: string;
    createdAt: string;
    updatedAt: string;
    status: CliReviewStatus;
    message: string;
    stageName?: string | null;
    stageLabel?: string | null;
    metadata?: Record<string, unknown> | null;
    finishedAt?: string | null;
}

export interface CliReviewSummary {
    executionUuid: string;
    correlationId?: string | null;
    status: CliReviewStatus;
    errorMessage?: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string | null;
    durationMs?: number | null;
    userEmail?: string | null;
    git?: {
        remote?: string | null;
        branch?: string | null;
        commitSha?: string | null;
        inferredPlatform?: string | null;
    } | null;
    cliVersion?: string | null;
    repositoryId?: string | null;
    repositoryName?: string | null;
    filesAnalyzed?: number | null;
    issuesFound?: number | null;
    cliAuth?: {
        mode: "team-key" | "personal";
        teamKeyName?: string | null;
        loggedInUserEmail?: string | null;
    } | null;
}

export interface CliReviewIssue {
    file?: string;
    line?: number;
    severity?: string;
    category?: string;
    title?: string;
    message?: string;
    suggestion?: string;
}

export interface CliReviewResult {
    summary?: string;
    issues?: CliReviewIssue[];
    filesAnalyzed?: number;
    duration?: number;
}

export interface CliReviewDetail extends CliReviewSummary {
    timeline: CliReviewTimelineItem[];
    result?: CliReviewResult;
}

export interface PaginatedCliReviews {
    data: CliReviewSummary[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}
