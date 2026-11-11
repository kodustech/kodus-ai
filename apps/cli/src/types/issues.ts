export type IssueStatus = 'open' | 'resolved' | 'dismissed';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

/** One row of GET /issues: the issues of the organization the user may read. */
export type IssueListItem = {
    uuid: string;
    title: string;
    severity: IssueSeverity;
    status: IssueStatus;
    filePath: string;
    label?: string;
    /** 'security_scan' for a deep-scan finding; absent for a code-review issue. */
    source?: string;
    cwe?: string;
    createdAt: string;
    repository: { id: string; name: string };
};

/** POST /issues/fix-prompt. */
export type IssuesFixPrompt = {
    /** Empty when no issue could be included. */
    prompt: string;
    included: string[];
    /** Unknown, or in a repository the user cannot read. */
    skipped: string[];
};
