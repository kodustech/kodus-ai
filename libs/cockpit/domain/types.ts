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
