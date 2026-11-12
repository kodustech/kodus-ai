import type {
    ApiFileSuggestion,
    ApiPrLevelSuggestion,
    ApiSuggestionsObject,
    PullRequestSuggestionsResponse,
    ReviewIssue,
    ReviewResult,
    Severity,
} from '../types/review.js';

export function normalizeSeverity(severity?: string): Severity {
    if (!severity) {
        return 'info';
    }
    const normalized = severity.toLowerCase();
    if (normalized === 'critical') {
        return 'critical';
    }
    if (normalized === 'high' || normalized === 'error') {
        return 'error';
    }
    if (normalized === 'medium' || normalized === 'warning') {
        return 'warning';
    }
    return 'info';
}

export function mapFileSuggestions(files: ApiFileSuggestion[]): ReviewIssue[] {
    return files.map((suggestion) => ({
        file: suggestion.filePath ?? suggestion.relevantFile,
        line: suggestion.relevantLinesStart ?? 1,
        endLine: suggestion.relevantLinesEnd,
        severity: normalizeSeverity(suggestion.severity),
        message: suggestion.fullExplanation || suggestion.suggestionContent,
        suggestion: suggestion.oneSentenceSummary,
        ruleId: suggestion.label,
    }));
}

export function mapPrLevelSuggestions(
    prLevel: ApiPrLevelSuggestion[],
): ReviewIssue[] {
    return prLevel.map((suggestion) => ({
        file: 'PR',
        line: 0,
        severity: normalizeSeverity(suggestion.severity),
        message: suggestion.fullExplanation || suggestion.suggestionContent,
        suggestion: suggestion.oneSentenceSummary,
        ruleId: suggestion.label,
    }));
}

export function normalizeIssueSeverities(issues: ReviewIssue[]): ReviewIssue[] {
    return issues.map((issue) => ({
        ...issue,
        severity: normalizeSeverity(issue.severity),
    }));
}

export function normalizeSuggestionsResponse(
    response: PullRequestSuggestionsResponse,
): ReviewResult {
    let issues: ReviewIssue[] = [];

    if (Array.isArray(response.issues)) {
        issues = normalizeIssueSeverities(response.issues);
    } else if (Array.isArray(response.suggestions)) {
        issues = normalizeIssueSeverities(response.suggestions);
    } else if (
        response.suggestions &&
        typeof response.suggestions === 'object'
    ) {
        const suggestionsObj = response.suggestions as ApiSuggestionsObject;
        issues = [
            ...mapFileSuggestions(suggestionsObj.files ?? []),
            ...mapPrLevelSuggestions(suggestionsObj.prLevel ?? []),
        ];
    }

    return {
        summary: response.summary ?? 'Pull request suggestions',
        issues,
        filesAnalyzed:
            response.filesAnalyzed ??
            new Set(issues.map((issue) => issue.file)).size,
        duration: response.duration ?? 0,
    };
}

/**
 * Normalizes severities on a result returned by the `/cli/review` job API,
 * which emits low/medium/high/critical, so `kodus review` and
 * `kodus pr suggestions` share the same severity vocabulary.
 */
export function normalizeReviewResult(result: ReviewResult): ReviewResult {
    if (!result || !Array.isArray(result.issues)) {
        return result;
    }
    return { ...result, issues: normalizeIssueSeverities(result.issues) };
}
