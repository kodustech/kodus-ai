const API_BASE =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type ReviewIssue = {
    file: string;
    line: number;
    endLine?: number;
    severity: string;
    category?: string;
    message: string;
    suggestion?: string;
    recommendation?: string;
    ruleId?: string;
};

export type PrAuthor = {
    login: string;
    avatarUrl?: string;
    htmlUrl?: string;
};

export type PrReviewer = {
    login: string;
    avatarUrl?: string;
    state: "approved" | "changes_requested" | "commented" | "pending";
};

export type PrChecks = {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    conclusion: "success" | "failure" | "partial" | "pending" | "unknown";
};

export type PrCommit = {
    sha: string;
    message: string;
    authorLogin?: string;
    authorAvatarUrl?: string;
    authoredAt?: string;
    htmlUrl: string;
};

export type PrComment = {
    id: number;
    authorLogin?: string;
    authorAvatarUrl?: string;
    body: string;
    createdAt: string;
    htmlUrl: string;
    kind: "issue" | "review";
    path?: string;
    line?: number;
};

export type PrLabel = {
    name: string;
    color?: string;
    description?: string;
};

export type PrAssignee = {
    login: string;
    avatarUrl?: string;
    htmlUrl?: string;
};

export type PrInfo = {
    owner: string;
    repo: string;
    prNumber: number;
    title: string;
    state?: "open" | "closed";
    merged?: boolean;
    isDraft?: boolean;
    headSha: string;
    headRef?: string;
    baseSha: string;
    baseRef?: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    commitsCount?: number;
    discussionCount?: number;
    htmlUrl: string;
    author?: PrAuthor;
    reviewers?: PrReviewer[];
    checks?: PrChecks;
    commits?: PrCommit[];
    comments?: PrComment[];
    labels?: PrLabel[];
    assignees?: PrAssignee[];
    body?: string;
    aiAnalysis?: string;
    groupings?: PrGrouping[];
};

export type PrGrouping = {
    title: string;
    explanation: string;
    files: string[];
};

export type EnqueueResponse = {
    jobId: string;
    status: string;
    statusUrl: string;
    pr: PrInfo;
    diff: string;
};

export type JobStatusResponse = {
    jobId: string;
    status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | string;
    result?: {
        summary: string;
        issues: ReviewIssue[];
        filesAnalyzed: number;
        duration: number;
    };
    error?: string;
    createdAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
    /** Public-demo only: original PR metadata persisted on the job. */
    publicPr?: PrInfo;
    /** Public-demo only: raw unified diff persisted on the job. */
    publicDiff?: string;
};

export type ApiError = {
    code?:
        | "invalid_url"
        | "requires_auth"
        | "too_large"
        | "rate_limited"
        | "upstream_error";
    message: string;
    statusCode: number;
};

async function jsonOrThrow(response: Response) {
    let body: any = null;
    try {
        body = await response.json();
    } catch {
        // body may be empty; fall through to status-based error
    }
    if (!response.ok) {
        // Error responses can be wrapped (e.g. {data:{message,code}}) or
        // flat ({message,code}) depending on which Nest filter caught it.
        const payload = body?.data ?? body;
        const err: ApiError = {
            code: payload?.code,
            message:
                payload?.message ||
                payload?.error ||
                `Request failed with ${response.status}`,
            statusCode: response.status,
        };
        throw err;
    }
    // Success responses are wrapped by the global response interceptor as
    // {data, statusCode, type}. Unwrap so callers see the controller's
    // actual return value.
    return body?.data ?? body;
}

export async function enqueuePublicReview(
    prUrl: string,
    fingerprint: string,
): Promise<EnqueueResponse> {
    const response = await fetch(`${API_BASE}/cli/public/review-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl, fingerprint }),
    });
    return jsonOrThrow(response);
}

export async function getJobStatus(
    jobId: string,
    opts: { omitPayload?: boolean } = {},
): Promise<JobStatusResponse> {
    const qs = opts.omitPayload ? "?omit=payload" : "";
    const response = await fetch(
        `${API_BASE}/cli/public/review/jobs/${encodeURIComponent(jobId)}${qs}`,
        { method: "GET", headers: { Accept: "application/json" } },
    );
    return jsonOrThrow(response);
}

export type FeaturedReviewSummary = {
    slug: string;
    tags: string[];
    highlight?: string;
    prUrl: string;
    pr: PrInfo;
    issuesCount: number;
    sortOrder?: number;
};

export type FeaturedReviewDetail = {
    slug: string;
    tags: string[];
    highlight?: string;
    prUrl: string;
    pr: PrInfo;
    diff: string;
    result: {
        summary: string;
        issues: ReviewIssue[];
        filesAnalyzed: number;
        duration: number;
    };
};

export async function listFeaturedReviews(): Promise<FeaturedReviewSummary[]> {
    const response = await fetch(`${API_BASE}/cli/public/featured-reviews`, {
        method: "GET",
        headers: { Accept: "application/json" },
    });
    const body = await jsonOrThrow(response);
    return body?.items ?? [];
}

export async function getFeaturedReview(
    slug: string,
): Promise<FeaturedReviewDetail> {
    const response = await fetch(
        `${API_BASE}/cli/public/featured-reviews/${encodeURIComponent(slug)}`,
        { method: "GET", headers: { Accept: "application/json" } },
    );
    return jsonOrThrow(response);
}
