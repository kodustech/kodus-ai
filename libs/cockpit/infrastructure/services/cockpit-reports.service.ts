import { Inject, Injectable } from '@nestjs/common';

import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import {
    computePreviousPeriod,
    computeTrend,
    lastNCompleteWeeks,
    lastNMonths,
} from '../../application/date-range.util';
import { computeRuleState } from '../../domain/helpers/kody-rules-health.helper';
import {
    CategoryQualityRow,
    FeedbackGroup,
    MonthlyRatePoint,
    OrgReportData,
    RepoRankingRow,
    RepoReportSection,
    ReportHighlight,
    ReportTrend,
    RuleGroupFeedback,
    RuleHealthRow,
    RuleHealthState,
    WeeklyImplementedPoint,
} from '../../domain/report-types';
import {
    CockpitRangeQuery,
    ImplementationRateByCategoryRow,
    KodyRuleUsageRow,
    NegativeFeedbackByCategoryRow,
    RepositoryHealthRow,
} from '../../domain/types';
import {
    COCKPIT_CODE_HEALTH_SERVICE_TOKEN,
    ICockpitCodeHealthService,
} from '../../domain/contracts/cockpit-code-health.service.contract';
import {
    COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN,
    ICockpitDeveloperProductivityService,
} from '../../domain/contracts/cockpit-developer-productivity.service.contract';
import {
    COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
    ICockpitReviewAnalyticsService,
} from '../../domain/contracts/cockpit-review-analytics.service.contract';
import { ICockpitReportsService } from '../../domain/contracts/cockpit-reports.service.contract';

/** Max rows the report shows for the category and rule-health tables. */
const MAX_CATEGORY_ROWS = 6;
const MAX_REPO_RULE_ROWS = 6;
const MAX_ORG_RULES_ATTENTION = 8;

/**
 * Repos built concurrently per batch. Each repo section fans out ~8 warehouse
 * queries, and the analytics pool is small — building all repos at once would
 * exhaust connections on large orgs, so bound the batch.
 */
const REPO_BUILD_CONCURRENCY = 4;

/** Title + severity for an active Kody Rule, keyed by rule id. */
type RuleMeta = { title: string; severity: string | null };
// lastNCompleteWeeks / lastNMonths live in date-range.util so they can be
// unit-tested without importing this (dependency-heavy) service.

/**
 * Minimum thumbs (across both origin groups) before the report shows an
 * explicit negative-feedback rate. Thumbs are opt-in, so a "% negative" over
 * a tiny base is noise — below this floor the template leans on
 * implementation rate alone.
 */
const MIN_FEEDBACK_VOTES = 10;

/** A repo needs at least this many reviews in the period to be ranked. */
const RANKING_MIN_REVIEWS = 10;

/** A repo needs at least this many reviews to qualify for a highlight. */
const HIGHLIGHT_MIN_REVIEWS = 10;

/**
 * Assembles the actionable review reports (per-repo digest + org report) from
 * the existing warehouse-backed cockpit services. Pure composition: no new
 * queries beyond {@link CockpitReviewAnalyticsService.getReviewQualityByRuleGroup}.
 */
@Injectable()
export class CockpitReportsService implements ICockpitReportsService {
    constructor(
        @Inject(COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN)
        private readonly review: ICockpitReviewAnalyticsService,
        @Inject(COCKPIT_CODE_HEALTH_SERVICE_TOKEN)
        private readonly codeHealth: ICockpitCodeHealthService,
        @Inject(COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN)
        private readonly productivity: ICockpitDeveloperProductivityService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRules: IKodyRulesService,
    ) {}

    /**
     * Build one repo's section, or `null` when the repo had no reviews in the
     * window (the digest omits empty repos so admins never get noise).
     */
    async buildRepoSection(
        organizationId: string,
        repository: string,
        startDate: string,
        endDate: string,
        ruleTitles?: Map<string, RuleMeta>,
    ): Promise<RepoReportSection | null> {
        const q: CockpitRangeQuery = {
            organizationId,
            startDate,
            endDate,
            repository,
        };
        const prev = computePreviousPeriod(startDate, endDate);

        const ops = await this.review.getReviewOperationalMetrics(q);
        const reviews = ops.currentPeriod.processedReviews;
        if (reviews <= 0) {
            return null;
        }

        const titles = ruleTitles ?? (await this.getRuleTitles(organizationId));

        const [
            implCur,
            implPrev,
            severity,
            groups,
            weekly,
            implByCat,
            negByCat,
            rulesUsage,
        ] = await Promise.all([
            this.codeHealth.getImplementationRate({
                organizationId,
                repository,
                startDate,
                endDate,
            }),
            this.codeHealth.getImplementationRate({
                organizationId,
                repository,
                startDate: prev.startDate,
                endDate: prev.endDate,
            }),
            this.review.getImplementationRateBySeverity(q),
            this.review.getReviewQualityByRuleGroup(q),
            this.review.getImplementationRateWeekly({
                ...q,
                ...lastNCompleteWeeks(endDate, 4),
            }),
            this.review.getImplementationRateByCategory(q),
            this.review.getNegativeFeedbackByCategory(q),
            this.review.getKodyRulesUsage(q),
        ]);

        const critical = severity.find((r) => r.severity === 'critical');

        const sentTrend = computeTrend(
            implCur.suggestionsSent,
            implPrev.suggestionsSent,
            'up',
        );

        // Only rules worth acting on — a healthy rule in the digest is noise.
        const repoRules = buildRuleHealth(rulesUsage, titles).filter(
            (r) => r.state === 'noisy' || r.state === 'ignored',
        );

        return {
            repository,
            reviews,
            reviewsTrend: ops.comparison.processedReviews.trend,
            reviewsChangePct: ops.comparison.processedReviews.percentageChange,
            suggestionsSent: implCur.suggestionsSent,
            suggestionsSentTrend: sentTrend.trend,
            suggestionsSentChangePct: sentTrend.percentageChange,
            implementationRate: implCur.implementationRate,
            implementationRateTrend: ppTrend(
                implCur.implementationRate,
                implPrev.implementationRate,
                'up',
            ),
            implementationRatePpChange: round2(
                (implCur.implementationRate - implPrev.implementationRate) *
                    100,
            ),
            criticalImplemented: critical?.implemented ?? 0,
            criticalSent: critical?.sent ?? 0,
            weeklyImplemented: toWeeklyPoints(weekly),
            feedback: toFeedback(groups),
            categories: mergeCategories(implByCat, negByCat),
            rules: repoRules.slice(0, MAX_REPO_RULE_ROWS),
            rulesMore: Math.max(0, repoRules.length - MAX_REPO_RULE_ROWS),
        };
    }

    /**
     * Build the digest sections for the repos an admin administers. Repos
     * with no activity are dropped; an empty result means "send nothing".
     */
    async buildRepoSections(
        organizationId: string,
        repositories: string[],
        startDate: string,
        endDate: string,
    ): Promise<RepoReportSection[]> {
        const titles = await this.getRuleTitles(organizationId);
        const out: RepoReportSection[] = [];
        // Bounded batches so a many-repo org doesn't exhaust the warehouse pool.
        for (let i = 0; i < repositories.length; i += REPO_BUILD_CONCURRENCY) {
            const batch = repositories.slice(i, i + REPO_BUILD_CONCURRENCY);
            const sections = await Promise.all(
                batch.map((repo) =>
                    this.buildRepoSection(
                        organizationId,
                        repo,
                        startDate,
                        endDate,
                        titles,
                    ),
                ),
            );
            out.push(
                ...sections.filter(
                    (s): s is RepoReportSection => s !== null,
                ),
            );
        }
        return out;
    }

    /** Build the org-level executive report. */
    async buildOrgReport(
        organizationId: string,
        company: string,
        startDate: string,
        endDate: string,
    ): Promise<OrgReportData> {
        const q: CockpitRangeQuery = { organizationId, startDate, endDate };
        const prev = computePreviousPeriod(startDate, endDate);

        // Activity gate first: the org cron runs across EVERY active org, so
        // an org with no reviews in the window must stay cheap — bail here
        // before the ~12-query fan-out below instead of paying for all of it.
        const ops = await this.review.getReviewOperationalMetrics(q);
        if (ops.currentPeriod.processedReviews <= 0) {
            return emptyOrgReport(company, startDate, endDate);
        }

        const [
            implCur,
            implPrev,
            severity,
            leadTime,
            repos,
            rulesUsage,
            ruleTitles,
        ] = await Promise.all([
            this.codeHealth.getImplementationRate({
                organizationId,
                startDate,
                endDate,
            }),
            this.codeHealth.getImplementationRate({
                organizationId,
                startDate: prev.startDate,
                endDate: prev.endDate,
            }),
            this.review.getImplementationRateBySeverity(q),
            // Targeted cycle-time query only — NOT getCompanyDashboardInsights,
            // which also builds a cross-org ranking that scans every org in the
            // warehouse and times out the connection on large prod datasets.
            this.productivity.getLeadTimeHighlight(q),
            this.review.getRepositoriesHealth(q),
            this.review.getKodyRulesUsage(q),
            this.getRuleTitles(organizationId),
        ]);

        const critical = severity.find((r) => r.severity === 'critical');
        const cycle = leadTime;
        const attnAll = buildRuleHealth(rulesUsage, ruleTitles).filter(
            (r) => r.state === 'noisy' || r.state === 'ignored',
        );
        const rulesNeedingAttention = attnAll.slice(
            0,
            MAX_ORG_RULES_ATTENTION,
        );

        const [evolution, highlights] = await Promise.all([
            this.buildImplementationRateEvolution(organizationId, endDate),
            // Reuse the current-period repo health already fetched above
            // instead of re-querying it inside buildHighlights.
            this.buildHighlights(organizationId, prev, repos),
        ]);

        return {
            company,
            startDate,
            endDate,
            reviews: ops.currentPeriod.processedReviews,
            reviewsTrend: ops.comparison.processedReviews.trend,
            reviewsChangePct: ops.comparison.processedReviews.percentageChange,
            implementationRate: implCur.implementationRate,
            implementationRateTrend: ppTrend(
                implCur.implementationRate,
                implPrev.implementationRate,
                'up',
            ),
            implementationRatePpChange: round2(
                (implCur.implementationRate - implPrev.implementationRate) *
                    100,
            ),
            suggestionsImplemented: implCur.suggestionsImplemented,
            criticalImplemented: critical?.implemented ?? 0,
            prCycleTimeHours: cycle?.currentPeriod.leadTimeP75Hours ?? 0,
            prCycleTimeTrend: cycle?.comparison.trend ?? 'unchanged',
            prCycleTimeChangePct: cycle?.comparison.percentageChange ?? 0,
            implementationRateEvolution: evolution,
            repoRanking: toRanking(repos),
            highlights,
            rulesNeedingAttention,
            rulesNeedingAttentionMore:
                attnAll.length - rulesNeedingAttention.length,
        };
    }

    /** Active Kody Rules for the org → `ruleId → {title, severity}`. */
    private async getRuleTitles(
        organizationId: string,
    ): Promise<Map<string, RuleMeta>> {
        const doc = await this.kodyRules.findByOrganizationId(organizationId);
        const map = new Map<string, RuleMeta>();
        for (const rule of doc?.rules ?? []) {
            if (
                rule.uuid &&
                rule.title &&
                rule.status === KodyRulesStatus.ACTIVE
            ) {
                map.set(rule.uuid, {
                    title: rule.title,
                    severity: rule.severity ?? null,
                });
            }
        }
        return map;
    }

    private async buildImplementationRateEvolution(
        organizationId: string,
        endDate: string,
    ): Promise<MonthlyRatePoint[]> {
        const months = lastNMonths(endDate, 3);
        const rates = await Promise.all(
            months.map((m) =>
                this.codeHealth.getImplementationRate({
                    organizationId,
                    startDate: m.monthStart,
                    endDate: m.monthEnd,
                }),
            ),
        );
        return months.map((m, i) => ({
            monthStart: m.monthStart,
            label: m.label,
            rate: rates[i].implementationRate,
        }));
    }

    private async buildHighlights(
        organizationId: string,
        prev: { startDate: string; endDate: string },
        current: RepositoryHealthRow[],
    ): Promise<ReportHighlight[]> {
        const previous = await this.review.getRepositoriesHealth({
            organizationId,
            startDate: prev.startDate,
            endDate: prev.endDate,
        });

        const prevByRepo = new Map(
            previous.map((r) => [r.repository, r.implementationRate]),
        );

        let best: { repository: string; from: number; to: number } | null =
            null;
        for (const repo of current) {
            if (repo.prsReviewed < HIGHLIGHT_MIN_REVIEWS) {
                continue;
            }
            const from = prevByRepo.get(repo.repository);
            if (from === undefined) {
                continue;
            }
            const delta = repo.implementationRate - from;
            if (delta <= 0) {
                continue;
            }
            if (!best || delta > best.to - best.from) {
                best = {
                    repository: repo.repository,
                    from,
                    to: repo.implementationRate,
                };
            }
        }

        if (!best) {
            return [];
        }

        return [
            {
                kind: 'impl_rate_growth',
                repository: best.repository,
                detail: `Implementation rate ${pct(best.from)} → ${pct(
                    best.to,
                )} (+${round2((best.to - best.from) * 100)}pp)`,
            },
        ];
    }
}

function toWeeklyPoints(
    rows: { weekStart: string; sent: number; implemented: number }[],
): WeeklyImplementedPoint[] {
    return rows.map((r) => ({
        weekStart: r.weekStart,
        sent: r.sent,
        implemented: r.implemented,
    }));
}

function toFeedback(
    groups: {
        group: 'kody_rules' | 'general';
        sent: number;
        implemented: number;
        rate: number;
        thumbsUp: number;
        thumbsDown: number;
    }[],
): RuleGroupFeedback {
    const pick = (name: 'kody_rules' | 'general'): FeedbackGroup => {
        const g = groups.find((r) => r.group === name);
        const thumbsUp = g?.thumbsUp ?? 0;
        const thumbsDown = g?.thumbsDown ?? 0;
        const votes = thumbsUp + thumbsDown;
        return {
            suggestionsSent: g?.sent ?? 0,
            implementationRate: g?.rate ?? 0,
            thumbsUp,
            thumbsDown,
            negativeRate: votes > 0 ? round2(thumbsDown / votes) : null,
        };
    };

    const kodyRules = pick('kody_rules');
    const general = pick('general');
    const totalVotes =
        kodyRules.thumbsUp +
        kodyRules.thumbsDown +
        general.thumbsUp +
        general.thumbsDown;

    return {
        totalVotes,
        hasEnoughVotes: totalVotes >= MIN_FEEDBACK_VOTES,
        kodyRules,
        general,
    };
}

/** Merge per-category implementation rate with per-category feedback. */
function mergeCategories(
    implByCat: ImplementationRateByCategoryRow[],
    negByCat: NegativeFeedbackByCategoryRow[],
): CategoryQualityRow[] {
    const feedback = new Map(negByCat.map((f) => [f.category, f]));
    return implByCat
        .filter(
            (c) =>
                c.category &&
                c.category.toLowerCase() !== 'kody_rules' &&
                c.sent > 0,
        )
        .map((c) => {
            const f = feedback.get(c.category);
            return {
                category: c.category,
                sent: c.sent,
                implementationRate: c.rate,
                thumbsUp: f?.thumbsUp ?? 0,
                thumbsDown: f?.thumbsDown ?? 0,
            };
        })
        .sort((a, b) => b.sent - a.sent)
        .slice(0, MAX_CATEGORY_ROWS);
}

/**
 * Per-rule health for rules that triggered in the window. Usage rows whose
 * rule is no longer active (or was deleted) are dropped — they can't be acted
 * on. Sorted worst-health first, then by volume.
 */
function buildRuleHealth(
    usageRows: KodyRuleUsageRow[],
    titles: Map<string, RuleMeta>,
): RuleHealthRow[] {
    const rows: RuleHealthRow[] = [];
    for (const u of usageRows) {
        const meta = titles.get(u.ruleId);
        if (!meta) {
            continue;
        }
        const { state, usage } = computeRuleState(u);
        rows.push({
            ruleId: u.ruleId,
            title: meta.title,
            triggers: usage.triggers,
            implementationRate: usage.rate,
            thumbsUp: usage.thumbsUp,
            thumbsDown: usage.thumbsDown,
            state,
        });
    }
    return rows.sort(
        (a, b) =>
            stateRank(a.state) - stateRank(b.state) || b.triggers - a.triggers,
    );
}

/** Worst (most actionable) health states sort first. */
function stateRank(state: RuleHealthState): number {
    switch (state) {
        case 'noisy':
            return 0;
        case 'ignored':
            return 1;
        case 'low_data':
            return 2;
        case 'healthy':
            return 3;
        case 'stale':
            return 4;
        default:
            return 5;
    }
}

/** Zeroed org report for an org with no activity — the use-case skips it. */
function emptyOrgReport(
    company: string,
    startDate: string,
    endDate: string,
): OrgReportData {
    return {
        company,
        startDate,
        endDate,
        reviews: 0,
        reviewsTrend: 'unchanged',
        reviewsChangePct: 0,
        implementationRate: 0,
        implementationRateTrend: 'unchanged',
        implementationRatePpChange: 0,
        suggestionsImplemented: 0,
        criticalImplemented: 0,
        prCycleTimeHours: 0,
        prCycleTimeTrend: 'unchanged',
        prCycleTimeChangePct: 0,
        implementationRateEvolution: [],
        repoRanking: [],
        highlights: [],
        rulesNeedingAttention: [],
        rulesNeedingAttentionMore: 0,
    };
}

function toRanking(
    repos: {
        repository: string;
        prsReviewed: number;
        implementationRate: number;
    }[],
): RepoRankingRow[] {
    return repos
        .filter((r) => r.prsReviewed >= RANKING_MIN_REVIEWS)
        .sort((a, b) => b.implementationRate - a.implementationRate)
        .map((r, i) => ({
            rank: i + 1,
            repository: r.repository,
            reviews: r.prsReviewed,
            implementationRate: r.implementationRate,
        }));
}

/** Trend from a percentage-point delta (rates are 0..1). */
function ppTrend(
    current: number,
    previous: number,
    directionOfImprovement: 'up' | 'down',
): ReportTrend {
    const delta = current - previous;
    if (Math.abs(delta) < 1e-9) {
        return 'unchanged';
    }
    const improved = directionOfImprovement === 'up' ? delta > 0 : delta < 0;
    return improved ? 'improved' : 'worsened';
}

function round2(value: number): number {
    return Number(value.toFixed(2));
}

function pct(rate: number): string {
    return `${Math.round(rate * 100)}%`;
}
