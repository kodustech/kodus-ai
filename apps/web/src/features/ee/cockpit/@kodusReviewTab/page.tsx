import { extractApiData } from "../_helpers/api-data-extractor";
import { getSelectedDateRange } from "../_helpers/get-selected-date-range";
import {
    getIgnoredCriticals,
    getImplementationRateByCategory,
    getImplementationRateBySeverity,
    getImplementationRateWeekly,
    getKodyRulesHealth,
    getNegativeFeedbackByCategory,
    getNegativeFeedbackWeekly,
    getNegativeVoteRate,
    getRepositoriesHealth,
    getReviewOperationalMetrics,
    getReviewOperationalOutcomesWeekly,
} from "../_services/analytics/review/fetch";
import {
    FeedbackSection,
    RateBySeverityChart,
    ReviewOperationalOutcomesChart,
    WeeklyImplementationChart,
} from "./_components/charts.no-ssr";
import { RateByCategoryChart } from "./_components/rate-by-category-chart";
import { RepositoriesHealthTable } from "./_components/repositories-health-table";
import { ReviewCards } from "./_components/review-cards";
import { ReviewSection } from "./_components/review-section";
import { RulesHealthTable } from "./_components/rules-health-table";

export default async function KodusReviewTab() {
    const { startDate, endDate } = await getSelectedDateRange();
    const params = { startDate, endDate };

    const [
        weekly,
        byCategory,
        bySeverity,
        ignoredCriticals,
        negativeByCategory,
        negativeWeekly,
        negativeVoteRate,
        operationalMetrics,
        operationalWeekly,
        repositoriesHealth,
        rulesHealth,
    ] = await Promise.all([
        getImplementationRateWeekly(params).then(extractApiData),
        getImplementationRateByCategory(params).then(extractApiData),
        getImplementationRateBySeverity(params).then(extractApiData),
        getIgnoredCriticals(params).then(extractApiData),
        getNegativeFeedbackByCategory(params).then(extractApiData),
        getNegativeFeedbackWeekly(params).then(extractApiData),
        getNegativeVoteRate(params).then(extractApiData),
        getReviewOperationalMetrics(params)
            .then(extractApiData)
            .catch(() => null),
        getReviewOperationalOutcomesWeekly(params)
            .then(extractApiData)
            .catch(() => null),
        getRepositoriesHealth(params).then(extractApiData),
        // rules health merges Mongo metadata — tolerate failures without
        // taking the whole tab down.
        getKodyRulesHealth(params)
            .then(extractApiData)
            .catch(() => []),
    ]);

    const totals = (weekly ?? []).reduce(
        (acc, w) => ({
            sent: acc.sent + w.sent,
            implemented: acc.implemented + w.implemented,
        }),
        { sent: 0, implemented: 0 },
    );

    return (
        <div className="flex flex-col gap-2">
            <ReviewCards
                sent={totals.sent}
                implemented={totals.implemented}
                negativeVoteRate={negativeVoteRate}
                ignoredCriticals={ignoredCriticals}
                operationalMetrics={operationalMetrics}
            />

            {operationalMetrics && operationalWeekly?.length ? (
                <ReviewSection
                    title="Review processing outcomes"
                    description="weekly composition · success, error, skipped">
                    <ReviewOperationalOutcomesChart
                        metrics={operationalMetrics}
                        weekly={operationalWeekly}
                    />
                </ReviewSection>
            ) : null}

            <ReviewSection
                title="Implementation rate — week over week"
                description="% of sent suggestions the team implemented">
                <WeeklyImplementationChart data={weekly ?? []} />
            </ReviewSection>

            <div className="grid grid-cols-2 gap-2">
                {/* Anchor + highlight target for the "Critical suggestions not
                    yet addressed" card — lands the user on the theme breakdown
                    (themes that get ignored), each bar drilling to PR samples,
                    instead of a flat list of individual findings. */}
                <section
                    id="themes-by-category"
                    className="target:ring-primary-light/60 h-full scroll-mt-24 rounded-xl transition-shadow target:ring-2">
                    <ReviewSection
                        title="Implementation rate by category"
                        description="sent vs. implemented · click a theme to see its PRs">
                        <RateByCategoryChart data={byCategory ?? []} />
                    </ReviewSection>
                </section>

                <ReviewSection
                    title="Implementation rate by severity"
                    description="expected: descending gradient (critical > low)">
                    <RateBySeverityChart data={bySeverity ?? []} />
                </ReviewSection>
            </div>

            <FeedbackSection
                byCategory={negativeByCategory ?? []}
                weekly={negativeWeekly ?? []}
            />

            <ReviewSection
                title="Repositories — health"
                description="where Kodus is landing vs. being ignored">
                <RepositoriesHealthTable data={repositoriesHealth ?? []} />
            </ReviewSection>

            <ReviewSection
                title="Kody Rules — health"
                description="how each rule is performing · click a row to see its suggestions">
                <RulesHealthTable data={rulesHealth ?? []} />
            </ReviewSection>
        </div>
    );
}
