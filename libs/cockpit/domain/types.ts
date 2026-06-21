/** Request query shared across most cockpit endpoints. */
export interface CockpitRangeQuery {
    organizationId: string;
    startDate: string;
    endDate: string;
    repository?: string;
}

export interface CockpitValidation {
    hasData: boolean;
    pullRequestsCount: number;
}

export interface SuggestionCategoryCount {
    category: string;
    count: number;
}

export interface RepositorySuggestions {
    repository: string;
    totalCount: number;
    categories: SuggestionCategoryCount[];
}

export interface BugRatioRow {
    weekStart: string;
    totalPRs: number;
    bugFixPRs: number;
    ratio: number;
}

export interface PeriodComparison<TCurrent, TPrevious = TCurrent> {
    currentPeriod: TCurrent;
    previousPeriod: TPrevious;
    comparison: {
        percentageChange: number;
        trend: 'improved' | 'worsened' | 'unchanged';
    };
}

export type BugRatioHighlight = PeriodComparison<{
    totalPRs: number;
    bugFixPRs: number;
    ratio: number;
}>;

export interface SuggestionsImplementationRate {
    suggestionsSent: number;
    suggestionsImplemented: number;
    implementationRate: number;
}

export interface DeployFrequencyRow {
    weekStart: string;
    prCount: number;
}

export type DeployFrequencyHighlight = PeriodComparison<{
    totalDeployments: number;
    averagePerWeek: number;
}>;

export interface LeadTimeRow {
    weekStart: string;
    leadTimeP75Minutes: number;
    leadTimeP75Hours: number;
}

export type LeadTimeHighlight = PeriodComparison<{
    leadTimeP75Minutes: number;
    leadTimeP75Hours: number;
}>;

export interface PullRequestsByDevRow {
    weekStart: string;
    author: string;
    prCount: number;
}

export interface PullRequestsOpenedVsClosedRow {
    weekStart: string;
    openedCount: number;
    closedCount: number;
    ratio: number;
}

export interface DeveloperActivityRow {
    developer: string;
    date: string;
    prCount: number;
}

export type PRSizeHighlight = PeriodComparison<{
    averagePRSize: number;
    totalPRs: number;
}>;

export interface PullRequestSizeRow {
    weekStart: string;
    averagePRSize: number;
    totalPRs: number;
}

export interface LeadTimeBreakdownRow {
    weekStart: string;
    prCount: number;
    codingTimeMinutes: number;
    codingTimeHours: number;
    pickupTimeMinutes: number;
    pickupTimeHours: number;
    reviewTimeMinutes: number;
    reviewTimeHours: number;
    totalTimeMinutes: number;
    totalTimeHours: number;
}

// -------------------------------------------------------------------------
// Kodus Review analytics (cockpit revamp) — implementation-rate breakdowns,
// ignored-criticals highlight, repository health and the suggestions
// explorer. All read from `analytics.suggestions_mv` + `pull_requests_opt`.
// -------------------------------------------------------------------------

/** sent / implemented counters plus the derived 0..1 rate. */
export interface ImplementationRateBreakdown {
    sent: number;
    implemented: number;
    rate: number;
}

export interface ImplementationRateWeeklyRow
    extends ImplementationRateBreakdown {
    weekStart: string;
    /** keyed by lowercase severity (`critical`, `high`, `medium`, `low`). */
    bySeverity: Record<string, ImplementationRateBreakdown>;
}

export interface ImplementationRateByCategoryRow
    extends ImplementationRateBreakdown {
    category: string;
}

export interface ImplementationRateBySeverityRow
    extends ImplementationRateBreakdown {
    severity: string;
    /**
     * Same counters excluding rule-driven suggestions (Kody Rules carry a
     * user-defined severity, not a Kodus risk call). Lets the chart toggle
     * between the full population and a Kodus-native calibration view.
     */
    nativeSent: number;
    nativeImplemented: number;
    nativeRate: number;
}

export interface IgnoredCriticalItem {
    suggestionId: string;
    repository: string | null;
    filePath: string | null;
    category: string | null;
    summary: string | null;
    pullRequestId: string;
    prNumber: number | null;
    prClosedAt: string | null;
}

/** Critical suggestions left unimplemented on PRs that were merged/closed. */
export interface IgnoredCriticalsHighlight {
    count: number;
    items: IgnoredCriticalItem[];
}

export interface RepositoryHealthRow {
    repository: string;
    prsReviewed: number;
    suggestionsSent: number;
    suggestionsImplemented: number;
    implementationRate: number;
    thumbsUp: number;
    thumbsDown: number;
    /** category with the lowest implementation rate (min. sample applies). */
    weakestCategory: {
        category: string;
        rate: number;
        sent: number;
    } | null;
}

/** Per-rule aggregation straight from the warehouse (no rule metadata). */
export interface KodyRuleUsageRow {
    ruleId: string;
    triggers: number;
    implemented: number;
    rate: number;
    thumbsUp: number;
    thumbsDown: number;
    lastTriggeredAt: string | null;
}

export type KodyRuleHealthState =
    | 'healthy'
    | 'noisy'
    | 'ignored'
    | 'stale'
    | 'low_data';

export interface NegativeFeedbackByCategoryRow {
    category: string;
    thumbsUp: number;
    thumbsDown: number;
}

export interface NegativeFeedbackWeeklyRow {
    weekStart: string;
    thumbsUp: number;
    thumbsDown: number;
}

export type NegativeVoteRateHighlight = PeriodComparison<{
    thumbsUp: number;
    thumbsDown: number;
    /** thumbsDown / (thumbsUp + thumbsDown), 0..1. */
    negativeRate: number;
}>;

export interface ReviewOperationalMetricsPeriod {
    /** Distinct PRs with a terminal review execution in the period. */
    processedPRs: number;
    /** Terminal review executions in the period. */
    processedReviews: number;
    successfulReviews: number;
    errorReviews: number;
    skippedReviews: number;
    successRate: number;
    errorRate: number;
    skippedRate: number;
}

export interface ReviewOperationalMetricsWeeklyRow
    extends ReviewOperationalMetricsPeriod {
    weekStart: string;
}

export interface ReviewOperationalMetricComparison {
    percentageChange: number;
    trend: 'improved' | 'worsened' | 'unchanged';
}

export interface ReviewOperationalRateComparison
    extends ReviewOperationalMetricComparison {
    percentagePointChange: number;
}

export interface ReviewOperationalMetrics {
    currentPeriod: ReviewOperationalMetricsPeriod;
    previousPeriod: ReviewOperationalMetricsPeriod;
    comparison: {
        processedPRs: ReviewOperationalMetricComparison;
        processedReviews: ReviewOperationalMetricComparison;
        successRate: ReviewOperationalRateComparison;
        errorRate: ReviewOperationalRateComparison;
        skippedRate: ReviewOperationalRateComparison;
    };
}

/** Warehouse usage merged with rule metadata from Mongo `kodyRules`. */
export interface KodyRuleHealthRow extends KodyRuleUsageRow {
    title: string;
    severity: string | null;
    /** External repo id the rule is scoped to; null → org-wide (global). */
    repositoryId: string | null;
    /** Resolved `repo_full_name` for `repositoryId`, when known. */
    repositoryName: string | null;
    /**
     * Directory id the rule is scoped to; null → not folder-scoped. This —
     * not `rule.path` (a file glob every rule carries) — is what makes a rule
     * folder-scoped.
     */
    directoryId: string | null;
    /**
     * Folder path(s) the directory groups, resolved from the code-review
     * config. A directory can span multiple folders; null when unresolved.
     */
    directoryFolders: string[] | null;
    /**
     * `noisy` (negative feedback) only becomes computable in phase 3 when
     * `suggestion_feedback` lands in the warehouse.
     */
    state: KodyRuleHealthState;
}

export interface SuggestionsExplorerQuery {
    organizationId: string;
    startDate: string;
    endDate: string;
    repository?: string;
    category?: string;
    severity?: string;
    /** Kody Rule UUID — matches suggestions enforcing this rule. */
    ruleId?: string;
    implementationStatus?:
        | 'implemented'
        | 'partially_implemented'
        | 'not_implemented';
    search?: string;
    page?: number;
    pageSize?: number;
}

export interface SuggestionsExplorerItem {
    suggestionId: string;
    repository: string | null;
    repositoryId: string | null;
    filePath: string | null;
    category: string | null;
    severity: string | null;
    implementationStatus: string | null;
    summary: string | null;
    existingCode: string | null;
    improvedCode: string | null;
    language: string | null;
    pullRequestId: string;
    prNumber: number | null;
    commentId: number | null;
    createdAt: string | null;
}

export interface SuggestionsExplorerResult {
    total: number;
    page: number;
    pageSize: number;
    items: SuggestionsExplorerItem[];
}

export interface CompanyDashboard {
    organizationId: string;
    period: { startDate: string; endDate: string };
    metrics: {
        totalPRs: number;
        criticalSuggestions: number;
        totalSuggestions: number;
        topSuggestionsCategories: SuggestionCategoryCount[];
        topDeveloper: { name: string; totalPRs: number };
        companyRanking: {
            rank: number;
            totalCompanies: number;
            percentageOfTotalPRs: number;
            totalPRsAllCompanies: number;
        };
    };
    additionalMetrics: {
        suggestionsAppliedPercentage?: number;
        suggestionsImplementedCount?: number;
        cycleTime?: LeadTimeHighlight;
        deployFrequency?: DeployFrequencyHighlight;
        bugRatio?: BugRatioHighlight;
        leadTimeBreakdown?: LeadTimeBreakdownRow[];
    };
}
