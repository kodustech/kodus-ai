export interface CliReviewIssueFix {
    range: {
        start: number;
        end: number;
    };
    replacement: string;
}

export interface CliReviewIssue {
    file: string;
    line: number;
    endLine?: number;
    severity: string;
    category?: string;
    message: string;
    suggestion?: string;
    recommendation?: string;
    ruleId?: string;
    fixable?: boolean;
    fix?: CliReviewIssueFix;
}

export interface CliReviewResponse {
    summary: string;
    issues: CliReviewIssue[];
    filesAnalyzed: number;
    duration: number;
}

export interface TrialCliReviewResponse extends CliReviewResponse {
    rateLimit?: {
        remaining: number;
        limit: number;
    };
}

export interface CliFileInput {
    path: string;
    content: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    diff: string;
}

export interface CliReviewConfig {
    severity?: string;
    rules?: {
        security?: boolean;
        performance?: boolean;
        style?: boolean;
        bestPractices?: boolean;
    };
    rulesOnly?: boolean;
    /**
     * Fast mode: uses the agent engine with a capped step budget and skips
     * heavy verification/recovery passes. Optimized for CLI pre-commit use
     * where feedback latency matters more than maximum finding coverage.
     */
    fast?: boolean;
    files?: CliFileInput[];
}

export interface CliReviewInput {
    diff: string;
    config?: CliReviewConfig;
}
