export interface Author {
    id: string;
    username: string;
    name: string;
}

// Daily digest ("PRs do dia") shown as the summary cards at the top of the list.
export interface PullRequestsDailyDigest {
    date: string;
    reviewedToday: number;
    needsAttention: number;
    erroredToday: number;
    awaitingReview: number;
}

export interface PullRequestsDailyDigestResponse {
    data: PullRequestsDailyDigest;
}

// All-time counts per segment tab.
export interface PullRequestsFacets {
    all: number;
    needsAttention: number;
    errored: number;
    awaiting: number;
    mine: number;
}

export interface PullRequestsFacetsResponse {
    data: PullRequestsFacets;
}

export interface AwaitingPullRequest {
    prId: string;
    prNumber: number;
    title: string;
    url: string;
    repositoryName: string;
    repositoryId: string;
    author: { username: string; name?: string };
    openedAt: string;
}

export interface AwaitingPullRequestsResponse {
    data: AwaitingPullRequest[];
}

export interface PullRequestAuthorOption {
    id: string;
    name: string;
    username: string;
    count: number;
}

export interface PullRequestAuthorsResponse {
    data: PullRequestAuthorOption[];
}

export interface AutomationExecution {
    uuid: string;
    status:
        | "success"
        | "error"
        | "in_progress"
        | "pending"
        | "skipped"
        | "partial_error";
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    origin: string;
}

export interface CodeReviewTimelineItem {
    uuid: string;
    createdAt: string;
    updatedAt: string;
    status: "in_progress" | "success" | "error" | "skipped" | "partial_error";
    message: string;
    stageName?: string | null;
    stageLabel?: string | null;
    metadata?:
        | {
              label?: string | null;
              visibility?: string | null;
              partialErrors?: Array<
                  | string
                  | {
                        path?: string;
                        file?: string;
                        message?: string;
                        isTimeout?: boolean;
                    }
              > | null;
              fileTimings?: Array<{
                  file: string;
                  durationMs: number;
                  status: "success" | "error" | "timeout";
              }> | null;
              cta?: {
                  label: string;
                  href: string;
                  external?: boolean;
              } | null;
          }
        | Record<string, any>
        | null;
    finishedAt?: string | null;
}

/**
 * Mirrors `ReviewWarning` from the backend
 * (libs/code-review/infrastructure/agents/engine/review-warnings.ts).
 * Emitted when the configured model's context window forced the
 * adaptive-fit pipeline into a degraded path. Surfaced in the admin
 * dashboard so operators can see when reviews ran at reduced fidelity;
 * intentionally absent from the PR author's GitHub comment.
 */
export type ReviewWarningKind =
    | "PROMPT_COMPACTED"
    | "CALLGRAPH_DROPPED"
    | "HUNK_HEADERS_ONLY"
    | "DIFF_TRUNCATED"
    | "LOW_SIGNAL_FILES_DROPPED"
    | "HEAVY_PASSES_SKIPPED"
    | "PROVIDER_FALLBACK";

export interface ReviewWarning {
    kind: ReviewWarningKind;
    reason: "small_context_window" | "provider_failover";
    contextWindowTokens: number;
    modelName: string;
    detail?: string;
    agentName?: string;
}

export interface PullRequestExecution {
    prId: string;
    prNumber: number;
    title: string;
    status: "open" | "closed" | "merged";
    merged: boolean;
    /** Whether the last review ran in HEAVY mode. */
    heavy?: boolean;
    url: string;
    baseBranchRef: string;
    headBranchRef: string;
    repositoryName: string;
    repositoryId: string;
    openedAt: string;
    closedAt: string;
    createdAt: string;
    updatedAt: string;
    provider: "GITHUB" | "GITLAB" | "BITBUCKET" | "AZURE_REPOS";
    author: Author;
    isDraft: boolean;
    automationExecution: AutomationExecution | null;
    codeReviewTimeline: CodeReviewTimelineItem[];
    enrichedData: Record<string, any>;
    suggestionsCount: {
        // Posted on the PR (deliveryStatus 'sent').
        sent: number;
        // Held back by the review config/priority rules ('not_sent').
        filtered: number;
        // Kody tried to post but couldn't ('failed'/'failed_lines_mismatch').
        failed?: number;
        // Superseded by a newer suggestion ('replaced').
        replaced?: number;
        bySeverity?: Record<"critical" | "high" | "medium" | "low", number>;
        categories?: string[];
    };
    reviewedCommitSha?: string | null;
    reviewedCommitUrl?: string | null;
    compareUrl?: string | null;
    executionId?: string | null;
    /** Adaptive-fit fidelity warnings — absent for full-fidelity runs. */
    reviewWarnings?: ReviewWarning[];
}

export interface PullRequestExecutionsPagination {
    totalItems?: number;
    // Distinct PRs matching the DB-level filters — the accurate header count.
    // Absent when the backend can't compute it (error/empty) or reflects only
    // DB-level filters (see the use-case), so the client trusts it as exact only
    // when no Mongo-side suggestion/author filter is active.
    distinctPrTotal?: number;
}

export type PullRequestExecutionsPayload =
    | PullRequestExecution[]
    | {
          data?: PullRequestExecution[] | null;
          _page_data?: PullRequestExecution[] | null;
          pagination?: PullRequestExecutionsPagination | null;
      }
    | null
    | undefined;

export interface PullRequestExecutionsResponse {
    data: PullRequestExecutionsPayload;
    statusCode: number;
    type: "Array" | string;
}

export interface PullRequestSuggestion {
    id?: string;
    filePath?: string;
    language?: string;
    suggestionContent?: string;
    existingCode?: string;
    improvedCode?: string;
    oneSentenceSummary?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    label?: string;
    severity?: string;
    deliveryStatus?: string;
    createdAt?: string;
    updatedAt?: string;
    comment?: { id: number | string; pullRequestReviewId: number | null };
}

export interface PullRequestSuggestionsPayload {
    prNumber: number;
    repositoryId: string;
    repositoryFullName?: string;
    suggestions: {
        files: PullRequestSuggestion[];
        prLevel: PullRequestSuggestion[];
    };
}

export interface PullRequestSuggestionsResponse {
    data: PullRequestSuggestionsPayload;
    statusCode: number;
    type: string;
}

export interface PullRequestFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
    previous_filename?: string;
}

export interface PullRequestCommit {
    sha: string;
    message: string;
    authorLogin?: string;
    authorAvatarUrl?: string;
    authoredAt?: string;
    htmlUrl: string;
}

export interface PullRequestFilesResponse {
    data: {
        files: PullRequestFile[];
        commits?: PullRequestCommit[];
    };
    statusCode: number;
    type: string;
}
