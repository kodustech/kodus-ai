/**
 * Shapes for the actionable review reports that replace the legacy weekly
 * recap: a per-repo digest for repo admins and an org-level report for the
 * owner. Everything here is derived from the analytics warehouse via the
 * existing cockpit services — no new ingestion.
 */

export type ReportTrend = 'improved' | 'worsened' | 'unchanged';

/** One implemented-per-week data point for the 4-week trend bars. */
export interface WeeklyImplementedPoint {
    weekStart: string; // YYYY-MM-DD (week start, Monday)
    sent: number;
    implemented: number;
}

/**
 * Review quality for one origin group (rule-driven vs Kodus-native). The
 * report leads with `implementationRate` (robust, large base) and treats
 * thumbs as a secondary "are people liking it?" signal.
 */
export interface FeedbackGroup {
    suggestionsSent: number;
    implementationRate: number; // 0..1
    thumbsUp: number;
    thumbsDown: number;
    /** thumbsDown / (up + down); null when this group received no votes. */
    negativeRate: number | null;
}

/**
 * The "is the team acting on / liking what we say?" block. Thumbs are
 * opt-in, so `hasEnoughVotes` gates whether the explicit negative-% is worth
 * showing — below the floor the template falls back to implementation rate
 * only.
 */
export interface RuleGroupFeedback {
    totalVotes: number;
    hasEnoughVotes: boolean;
    kodyRules: FeedbackGroup;
    general: FeedbackGroup;
}

/** Implementation + feedback for one suggestion category (bug, security, …). */
export interface CategoryQualityRow {
    category: string; // raw label, e.g. "security", "performance"
    sent: number;
    implementationRate: number; // 0..1
    thumbsUp: number;
    thumbsDown: number;
}

/** Health state for a Kody Rule — same taxonomy as the cockpit rules table. */
export type RuleHealthState =
    | 'healthy'
    | 'noisy'
    | 'ignored'
    | 'low_data'
    | 'stale';

/** One Kody Rule's health in the period (rules that actually triggered). */
export interface RuleHealthRow {
    ruleId: string;
    title: string;
    triggers: number;
    implementationRate: number; // 0..1
    thumbsUp: number;
    thumbsDown: number;
    state: RuleHealthState;
}

/** One repo's slice of a repo-admin digest. */
export interface RepoReportSection {
    repository: string; // org/repo full name
    reviews: number;
    reviewsTrend: ReportTrend;
    reviewsChangePct: number;
    suggestionsSent: number;
    suggestionsSentTrend: ReportTrend;
    suggestionsSentChangePct: number;
    implementationRate: number; // 0..1
    implementationRateTrend: ReportTrend;
    implementationRatePpChange: number; // percentage points vs previous
    /** Hero: critical-severity suggestions the team actually implemented. */
    criticalImplemented: number;
    criticalSent: number;
    weeklyImplemented: WeeklyImplementedPoint[];
    feedback: RuleGroupFeedback;
    /** Implementation + 👍/👎 broken out per suggestion category. */
    categories: CategoryQualityRow[];
    /** Kody Rules that triggered in this repo this period, worst-health first. */
    rules: RuleHealthRow[];
    /** Attention-worthy rules beyond the shown cap (for a "+N more" hint). */
    rulesMore: number;
}

/** Repo-admin digest: one email, a section per repo the admin administers. */
export interface RepoReportData {
    company: string;
    startDate: string;
    endDate: string;
    sections: RepoReportSection[];
}

/** A point in the org report's 3-month implementation-rate evolution. */
export interface MonthlyRatePoint {
    monthStart: string; // YYYY-MM-01
    label: string; // e.g. "Apr"
    rate: number; // 0..1
}

/** A repo row in the org report's intra-org ranking. */
export interface RepoRankingRow {
    rank: number;
    repository: string;
    reviews: number;
    implementationRate: number; // 0..1
}

/** A period highlight (e.g. biggest implementation-rate growth). */
export interface ReportHighlight {
    kind: 'impl_rate_growth';
    repository: string;
    detail: string;
}

/** Org-level executive report payload. */
export interface OrgReportData {
    company: string;
    startDate: string;
    endDate: string;
    reviews: number;
    reviewsTrend: ReportTrend;
    reviewsChangePct: number;
    implementationRate: number; // 0..1
    implementationRateTrend: ReportTrend;
    implementationRatePpChange: number;
    suggestionsImplemented: number;
    criticalImplemented: number;
    prCycleTimeHours: number;
    prCycleTimeTrend: ReportTrend;
    prCycleTimeChangePct: number;
    implementationRateEvolution: MonthlyRatePoint[];
    repoRanking: RepoRankingRow[];
    highlights: ReportHighlight[];
    /** Org-wide Kody Rules worth a look (noisy / ignored), worst first. */
    rulesNeedingAttention: RuleHealthRow[];
    /** Attention-worthy rules beyond the shown cap (for a "+N more" hint). */
    rulesNeedingAttentionMore: number;
}
