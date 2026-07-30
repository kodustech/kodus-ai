import { analyticsFetch, type AnalyticsParams } from "../utils";

// ---------------------------------------------------------------------
// "Kodus Review" tab — review-analytics endpoints (apps/api). Response
// types mirror `libs/cockpit/domain/types.ts`.
// ---------------------------------------------------------------------

export type ImplementationRateBreakdown = {
    sent: number;
    implemented: number;
    rate: number;
};

export type ImplementationRateWeeklyRow = ImplementationRateBreakdown & {
    weekStart: string;
    bySeverity: Record<string, ImplementationRateBreakdown>;
};

export type ImplementationRateByCategoryRow = ImplementationRateBreakdown & {
    category: string;
};

export type ImplementationRateBySeverityRow = ImplementationRateBreakdown & {
    severity: string;
    // same counters excluding rule-driven suggestions (Kody Rules carry a
    // user-defined severity, so they distort the Kodus calibration read).
    nativeSent: number;
    nativeImplemented: number;
    nativeRate: number;
};

export type IgnoredCriticalsHighlight = {
    count: number;
    items: Array<{
        suggestionId: string;
        repository: string | null;
        filePath: string | null;
        category: string | null;
        summary: string | null;
        pullRequestId: string;
        prNumber: number | null;
        prClosedAt: string | null;
    }>;
};

export type RepositoryHealthRow = {
    repository: string;
    prsReviewed: number;
    suggestionsSent: number;
    suggestionsImplemented: number;
    implementationRate: number;
    thumbsUp: number;
    thumbsDown: number;
    weakestCategory: {
        category: string;
        rate: number;
        sent: number;
    } | null;
};

export type KodyRuleHealthState =
    | "healthy"
    | "noisy"
    | "ignored"
    | "stale"
    | "low_data";

export type KodyRuleHealthRow = {
    ruleId: string;
    title: string;
    severity: string | null;
    repositoryId: string | null;
    repositoryName: string | null;
    directoryId: string | null;
    directoryFolders: string[] | null;
    state: KodyRuleHealthState;
    triggers: number;
    implemented: number;
    rate: number;
    thumbsUp: number;
    thumbsDown: number;
    lastTriggeredAt: string | null;
};

export type NegativeFeedbackByCategoryRow = {
    category: string;
    thumbsUp: number;
    thumbsDown: number;
};

export type NegativeFeedbackWeeklyRow = {
    weekStart: string;
    thumbsUp: number;
    thumbsDown: number;
};

export type NegativeVoteRateHighlight = {
    currentPeriod: {
        thumbsUp: number;
        thumbsDown: number;
        negativeRate: number;
    };
    previousPeriod: {
        thumbsUp: number;
        thumbsDown: number;
        negativeRate: number;
    };
    comparison: {
        percentageChange: number;
        trend: "improved" | "worsened" | "unchanged";
    };
};

export type ReviewOperationalMetrics = {
    currentPeriod: {
        processedPRs: number;
        processedReviews: number;
        successfulReviews: number;
        errorReviews: number;
        skippedReviews: number;
        successRate: number;
        errorRate: number;
        skippedRate: number;
    };
    previousPeriod: {
        processedPRs: number;
        processedReviews: number;
        successfulReviews: number;
        errorReviews: number;
        skippedReviews: number;
        successRate: number;
        errorRate: number;
        skippedRate: number;
    };
    comparison: {
        processedPRs: {
            percentageChange: number;
            trend: "improved" | "worsened" | "unchanged";
        };
        processedReviews: {
            percentageChange: number;
            trend: "improved" | "worsened" | "unchanged";
        };
        successRate: {
            percentageChange: number;
            percentagePointChange: number;
            trend: "improved" | "worsened" | "unchanged";
        };
        errorRate: {
            percentageChange: number;
            percentagePointChange: number;
            trend: "improved" | "worsened" | "unchanged";
        };
        skippedRate: {
            percentageChange: number;
            percentagePointChange: number;
            trend: "improved" | "worsened" | "unchanged";
        };
    };
};

export type ReviewOperationalMetricsWeeklyRow =
    ReviewOperationalMetrics["currentPeriod"] & {
        weekStart: string;
    };

const REVIEW_TAGS: { next: { tags: string[] } } = {
    next: {
        tags: [
            "cockpit-date-range-dependent",
            "cockpit-repository-dependent",
        ],
    },
};

export const getImplementationRateWeekly = (params: AnalyticsParams) =>
    analyticsFetch<ImplementationRateWeeklyRow[]>(
        "/review-analytics/charts/implementation-rate-weekly",
        { params, ...REVIEW_TAGS },
    );

export const getImplementationRateByCategory = (params: AnalyticsParams) =>
    analyticsFetch<ImplementationRateByCategoryRow[]>(
        "/review-analytics/charts/implementation-rate-by-category",
        { params, ...REVIEW_TAGS },
    );

export const getImplementationRateBySeverity = (params: AnalyticsParams) =>
    analyticsFetch<ImplementationRateBySeverityRow[]>(
        "/review-analytics/charts/implementation-rate-by-severity",
        { params, ...REVIEW_TAGS },
    );

export const getIgnoredCriticals = (params: AnalyticsParams) =>
    analyticsFetch<IgnoredCriticalsHighlight>(
        "/review-analytics/highlights/ignored-criticals",
        { params, ...REVIEW_TAGS },
    );

export const getRepositoriesHealth = (params: AnalyticsParams) =>
    analyticsFetch<RepositoryHealthRow[]>(
        "/review-analytics/tables/repositories-health",
        { params, ...REVIEW_TAGS },
    );

export const getKodyRulesHealth = (params: AnalyticsParams) =>
    analyticsFetch<KodyRuleHealthRow[]>(
        "/review-analytics/tables/kody-rules-health",
        { params, ...REVIEW_TAGS },
    );

export const getNegativeFeedbackByCategory = (params: AnalyticsParams) =>
    analyticsFetch<NegativeFeedbackByCategoryRow[]>(
        "/review-analytics/charts/negative-feedback-by-category",
        { params, ...REVIEW_TAGS },
    );

export const getNegativeFeedbackWeekly = (params: AnalyticsParams) =>
    analyticsFetch<NegativeFeedbackWeeklyRow[]>(
        "/review-analytics/charts/negative-feedback-weekly",
        { params, ...REVIEW_TAGS },
    );

export const getNegativeVoteRate = (params: AnalyticsParams) =>
    analyticsFetch<NegativeVoteRateHighlight>(
        "/review-analytics/highlights/negative-vote-rate",
        { params, ...REVIEW_TAGS },
    );

export const getReviewOperationalMetrics = (params: AnalyticsParams) =>
    analyticsFetch<ReviewOperationalMetrics>(
        "/review-analytics/highlights/operational-metrics",
        { params, ...REVIEW_TAGS },
    );

export const getReviewOperationalOutcomesWeekly = (params: AnalyticsParams) =>
    analyticsFetch<ReviewOperationalMetricsWeeklyRow[]>(
        "/review-analytics/charts/operational-outcomes-weekly",
        { params, ...REVIEW_TAGS },
    );
