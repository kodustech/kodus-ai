// Types ported from apps/try (src/lib/diff.ts + src/lib/api.ts) so the
// ported DiffViewer/SuggestionCard render exactly as in the try app. Kept
// minimal — only the fields the ported components actually read.

export type DiffFile = {
    path: string;
    oldPath: string | null;
    status: "added" | "deleted" | "renamed" | "modified";
    additions: number;
    deletions: number;
};

export type ReviewIssue = {
    id?: string;
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

export type PrInfo = {
    owner: string;
    repo: string;
    prNumber: number;
    htmlUrl: string;
    // The fields below are read by the ported PrHeader. They're optional so
    // the lighter buildPrInfo() (used only for the LLM-prompt context in the
    // diff viewer) can still produce a valid PrInfo without them.
    title?: string;
    state?: "open" | "closed";
    merged?: boolean;
    isDraft?: boolean;
    author?: {
        login: string;
        avatarUrl?: string;
        htmlUrl?: string;
    } | null;
    baseRef?: string;
    headRef?: string;
    headSha?: string;
    changedFiles?: number;
    additions?: number;
    deletions?: number;
    discussionCount?: number;
    commitsCount?: number;
    // Right-sidebar metadata. Web doesn't populate these yet, so the
    // matching cards simply don't render — but the shapes are here so the
    // ported RightSidebar type-checks and lights up if/when we wire them.
    reviewers?: PrReviewer[];
    checks?: PrChecks;
    labels?: PrLabel[];
    assignees?: PrAssignee[];
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

export type PrCommit = {
    sha: string;
    message: string;
    authorLogin?: string;
    authorAvatarUrl?: string;
    authoredAt?: string;
    htmlUrl: string;
};

export type PromptContext = {
    /** PR identifier shown in the prompt header (e.g. owner/repo#123). */
    prRef?: string;
    htmlUrl?: string;
};
