import {
    CockpitRangeQuery,
    IgnoredCriticalsHighlight,
    ImplementationRateByCategoryRow,
    ImplementationRateBySeverityRow,
    ImplementationRateWeeklyRow,
    KodyRuleUsageRow,
    NegativeFeedbackByCategoryRow,
    NegativeFeedbackWeeklyRow,
    NegativeVoteRateHighlight,
    RepositoryHealthRow,
    ReviewOperationalMetrics,
    ReviewOperationalMetricsWeeklyRow,
    SuggestionsExplorerQuery,
    SuggestionsExplorerResult,
} from '../types';

export const COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN = Symbol.for(
    'CockpitReviewAnalyticsService',
);

/**
 * Contract for the "Kodus Review" warehouse analytics. Consumers depend on
 * this interface + token rather than the concrete service, per the team's
 * DI-decoupling rule.
 */
export interface ICockpitReviewAnalyticsService {
    getImplementationRateWeekly(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateWeeklyRow[]>;
    getImplementationRateByCategory(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateByCategoryRow[]>;
    getImplementationRateBySeverity(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateBySeverityRow[]>;
    getIgnoredCriticals(
        q: CockpitRangeQuery,
    ): Promise<IgnoredCriticalsHighlight>;
    getRepositoriesHealth(
        q: CockpitRangeQuery,
    ): Promise<RepositoryHealthRow[]>;
    getNegativeFeedbackByCategory(
        q: CockpitRangeQuery,
    ): Promise<NegativeFeedbackByCategoryRow[]>;
    getNegativeFeedbackWeekly(
        q: CockpitRangeQuery,
    ): Promise<NegativeFeedbackWeeklyRow[]>;
    getNegativeVoteRateHighlight(
        q: CockpitRangeQuery,
    ): Promise<NegativeVoteRateHighlight>;
    getReviewOperationalMetrics(
        q: CockpitRangeQuery,
    ): Promise<ReviewOperationalMetrics>;
    getReviewOperationalMetricsWeekly(
        q: CockpitRangeQuery,
    ): Promise<ReviewOperationalMetricsWeeklyRow[]>;
    getKodyRulesUsage(q: CockpitRangeQuery): Promise<KodyRuleUsageRow[]>;
    /**
     * Map of `repositoryId` → `repo_full_name` for the org, from the
     * warehouse. Lets the rule-health table label scope ("which repo")
     * without a second round-trip — Kody rules only carry the external
     * `repositoryId`, not the name.
     */
    getRepositoryNames(organizationId: string): Promise<Map<string, string>>;
    searchSuggestions(
        q: SuggestionsExplorerQuery,
    ): Promise<SuggestionsExplorerResult>;
}
