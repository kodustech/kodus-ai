export type Severity = 'info' | 'warning' | 'error' | 'critical';

/** Severity values the API may return before normalization. */
export type ApiSeverity = Severity | 'high' | 'medium' | 'low';

export type IssueCategory =
    | 'security_vulnerability'
    | 'performance'
    | 'code_quality'
    | 'best_practices'
    | 'style'
    | 'bug'
    | 'complexity'
    | 'maintainability';

export interface CodeFix {
    type: 'replace' | 'insert' | 'delete';
    startLine: number;
    endLine: number;
    oldCode: string;
    newCode: string;
}

export interface ReviewIssue {
    file: string;
    line: number;
    endLine?: number;
    severity: Severity;
    category?: IssueCategory;
    message: string;
    suggestion?: string;
    recommendation?: string;
    ruleId?: string;
    fixable?: boolean;
    fix?: CodeFix;
}

export interface ReviewResult {
    summary: string;
    issues: ReviewIssue[];
    filesAnalyzed: number;
    duration: number;
}

export interface ApiFileSuggestion {
    id: string;
    relevantFile: string;
    filePath?: string;
    language?: string;
    suggestionContent: string;
    existingCode?: string;
    improvedCode?: string;
    oneSentenceSummary?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    label?: string;
    severity?: ApiSeverity;
    deliveryStatus?: string;
    implementationStatus?: string;
}

export interface ApiPrLevelSuggestion {
    id: string;
    suggestionContent: string;
    oneSentenceSummary?: string;
    label?: string;
    severity?: ApiSeverity;
    deliveryStatus?: string;
    files?: {
        violatedFileSha?: string[];
        relatedFileSha?: string[];
    };
}

export interface ApiSuggestionsObject {
    files?: ApiFileSuggestion[];
    prLevel?: ApiPrLevelSuggestion[];
}

export interface PullRequestSuggestionsResponse {
    summary?: string;
    issues?: ReviewIssue[];
    suggestions?: ReviewIssue[] | ApiSuggestionsObject;
    filesAnalyzed?: number;
    duration?: number;
    markdown?: string;
    deliveryStatus?: string;
}

export interface BusinessValidationResponse {
    accepted: boolean;
    mode: 'local_diff';
    command: string;
    repositoryName?: string;
    taskReference?: string;
    result: string;
}

export interface ReviewConfig {
    org?: string;
    repo?: string;
    severity?: Severity;
    rules?: {
        security?: boolean;
        performance?: boolean;
        style?: boolean;
        bestPractices?: boolean;
    };
    rulesOnly?: boolean;
    fast?: boolean;
    files?: FileContent[];
}

export interface FileContent {
    path: string;
    content: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    diff: string;
}

export interface TrialReviewResult extends ReviewResult {
    trialInfo?: {
        reviewsUsed: number;
        reviewsLimit: number;
        resetsAt: string;
    };
    rateLimit?: {
        remaining: number;
        limit: number;
        resetAt?: string;
    };
}
