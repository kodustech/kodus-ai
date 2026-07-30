"use client";

import { useEffect, useMemo, useState } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Skeleton } from "@components/ui/skeleton";
import {
    BaseUsageContract,
    ModelPricingInfo,
    UsageByAreaResultContract,
    UsageByReviewResultContract,
    UsageSummaryContract,
} from "@services/usage/types";
import { cn } from "src/core/utils/components";
import { DateRangePicker } from "src/features/ee/cockpit/_components/date-range-picker";

import { useTokenUsageFilters } from "../_hooks/filter.hook";
import { cacheSavings } from "../_utils/cost";
import { AreaBreakdown } from "./area-breakdown";
import { Chart, type ChartUnit } from "./chart";
import { Filters } from "./filters";
import { ModelBreakdownTable } from "./model-breakdown-table";
import { NoData } from "./no-data";
import { TokenUsageContentSkeleton } from "./page-skeleton";
import { ReviewActivityTable } from "./review-activity-table";
import { SpendLimitProgress } from "./spend-limit-progress";
import { SummaryCards } from "./summary-cards";

/** Section header per chart dimension — cockpit card-title/description. */
const CHART_SECTION: Record<string, { title: string; description: string }> = {
    "daily": {
        title: "Usage over time",
        description:
            "Daily usage split by uncached input, cache, output and reasoning.",
    },
    "by-pr": {
        title: "Top pull requests",
        description:
            "The pull requests that consumed the most tokens in the period.",
    },
    "by-review": {
        title: "Top review runs",
        description:
            "Each bar is one review run; a PR reviewed more than once appears once per run.",
    },
    "by-developer": {
        title: "Top developers",
        description: "Token spend attributed to the pull request author.",
    },
};

const ZERO_TOTALS = {
    input: 0,
    output: 0,
    total: 0,
    outputReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
};

export const TokenUsagePageClient = ({
    data,
    byArea,
    reviewRows,
    summary,
    previousTotals,
    activeDayCount,
    uniquePrCount,
    cookieValue,
    models,
    developers,
    teamId,
    pricing,
}: {
    data: BaseUsageContract[];
    byArea: UsageByAreaResultContract[];
    /** Raw by-review rows (per run × model) — feeds the activity table. */
    reviewRows: UsageByReviewResultContract[];
    summary: UsageSummaryContract | null;
    /** Same-length window immediately before the selected one. */
    previousTotals: { cost: number; tokens: number } | null;
    activeDayCount: number;
    uniquePrCount: number;
    cookieValue: string | undefined;
    models: string[];
    /** Distinct developer names for the by-developer picker (full roster). */
    developers: string[];
    teamId: string;
    pricing: Record<string, ModelPricingInfo>;
}) => {
    const [isMounted, setIsMounted] = useState(false);
    const [chartUnit, setChartUnit] = useState<ChartUnit>("tokens");

    const filters = useTokenUsageFilters(models);
    const { selectedModels, currentFilter, isPending } = filters;

    useEffect(() => {
        setIsMounted(true);
    }, []);

    const filteredData = useMemo(() => {
        if (!data) return [];
        return data.filter((d) => selectedModels.includes(d.model));
    }, [data, selectedModels]);

    /**
     * The summary endpoint already returns totals + per-token-type costs for
     * the WHOLE period, server-side, with correct per-call tier pricing. When
     * the user narrows the model filter we re-aggregate from `summary.byModel`
     * (which carries the same correct breakdown per model) so the cards stay
     * consistent with the detail table.
     */
    const totalUsage = useMemo(() => {
        if (!summary) return ZERO_TOTALS;

        const allModelsSelected = selectedModels.length === models.length;

        if (allModelsSelected) {
            return {
                input: summary.totals.input,
                output: summary.totals.output,
                total: summary.totals.total,
                outputReasoning: summary.totals.outputReasoning,
                cacheRead: summary.totals.cacheRead ?? 0,
                cacheWrite: summary.totals.cacheWrite ?? 0,
                totalCost: summary.totalCost.total,
                inputCost: summary.totalCost.input,
                outputCost: summary.totalCost.output,
                cacheReadCost: summary.totalCost.cacheRead,
                cacheWriteCost: summary.totalCost.cacheWrite,
            };
        }

        // Sum only the selected models' rows.
        return summary.byModel
            .filter((m) => selectedModels.includes(m.model))
            .reduce(
                (acc, row) => ({
                    input: acc.input + row.input,
                    output: acc.output + row.output,
                    total: acc.total + row.total,
                    outputReasoning: acc.outputReasoning + row.outputReasoning,
                    cacheRead: acc.cacheRead + (row.cacheRead ?? 0),
                    cacheWrite: acc.cacheWrite + (row.cacheWrite ?? 0),
                    totalCost: acc.totalCost + row.cost.total,
                    inputCost: acc.inputCost + row.cost.input,
                    outputCost: acc.outputCost + row.cost.output,
                    cacheReadCost: acc.cacheReadCost + row.cost.cacheRead,
                    cacheWriteCost: acc.cacheWriteCost + row.cost.cacheWrite,
                }),
                ZERO_TOTALS,
            );
    }, [summary, selectedModels, models]);

    const breakdownRows = useMemo(() => {
        if (!summary) return [];
        return summary.byModel.filter((m) => selectedModels.includes(m.model));
    }, [summary, selectedModels]);

    const avgPerDay =
        activeDayCount > 0 ? totalUsage.totalCost / activeDayCount : 0;
    const avgPerPR =
        uniquePrCount > 0 ? totalUsage.totalCost / uniquePrCount : 0;

    const filteredPricing = useMemo(() => {
        const result: Record<string, ModelPricingInfo> = {};
        for (const model of selectedModels) {
            if (pricing[model]) {
                result[model] = pricing[model];
            }
        }
        return result;
    }, [pricing, selectedModels]);

    // Helicone-style callout: what prompt caching saved vs full input price.
    const savedByCache = useMemo(() => {
        if (!summary) return 0;
        return cacheSavings(
            summary.byModel.filter((m) => selectedModels.includes(m.model)),
            pricing,
        );
    }, [summary, selectedModels, pricing]);

    // Render the content skeleton (not null) before mount so SSR and the
    // pre-hydration window show the placeholder layout instead of an empty body
    // that then pops in the real content.
    if (!isMounted) {
        return (
            <div className="flex flex-col gap-5">
                <TokenUsageContentSkeleton />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-5">
            {/* Filters Row */}
            <div className="flex items-center justify-between gap-4">
                <Filters
                    models={models}
                    developers={developers}
                    teamId={teamId}
                    filters={filters}
                />
                <DateRangePicker
                    cookieValue={cookieValue}
                    commitMode="onClose"
                />
            </div>

            {/* KPI row — period totals; identical across chart dimensions,
                so they stay put during a view switch (only the chart changes). */}
            <SummaryCards
                totalUsage={totalUsage}
                avgPerDay={avgPerDay}
                avgPerPR={avgPerPR}
                savedByCache={savedByCache}
                previousTotals={previousTotals}
            />

            {/* Month-to-date spend vs the configured BYOK limit */}
            <SpendLimitProgress />

            {/* Chart — the only thing that changes per view, so it shows a
                skeleton while the new dimension's data loads (consistent with
                the initial page skeleton) instead of a spinner. */}
            {isPending ? (
                <Skeleton className="h-[440px] w-full rounded-xl" />
            ) : (
                <Card color="lv1" className="h-[440px]">
                    <CardHeader className="flex-row items-start justify-between gap-4">
                        <div className="flex flex-col gap-1.5">
                            <CardTitle className="text-sm">
                                {CHART_SECTION[currentFilter]?.title ??
                                    CHART_SECTION.daily.title}
                            </CardTitle>
                            <CardDescription className="text-xs">
                                {CHART_SECTION[currentFilter]?.description ??
                                    CHART_SECTION.daily.description}
                            </CardDescription>
                        </div>
                        {/* Tokens ⇄ USD, like gateway dashboards lead with cost */}
                        <div className="bg-card-lv2 flex shrink-0 rounded-lg p-0.5">
                            {(["tokens", "usd"] as const).map((u) => (
                                <button
                                    key={u}
                                    type="button"
                                    onClick={() => setChartUnit(u)}
                                    className={cn(
                                        "cursor-pointer rounded-md px-3 py-1 text-xs font-semibold transition-colors",
                                        chartUnit === u
                                            ? "bg-card-lv3 text-text-primary"
                                            : "text-text-tertiary hover:text-text-secondary",
                                    )}>
                                    {u === "tokens" ? "Tokens" : "USD"}
                                </button>
                            ))}
                        </div>
                    </CardHeader>
                    <CardContent className="min-h-0 flex-1">
                        {filteredData && filteredData.length > 0 ? (
                            <Chart
                                data={filteredData}
                                filterType={currentFilter}
                                unit={chartUnit}
                                pricing={pricing}
                            />
                        ) : (
                            <NoData />
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Activity per review run — the drill-down behind the chart */}
            {currentFilter === "by-review" && !isPending && (
                <ReviewActivityTable
                    rows={reviewRows}
                    selectedModels={selectedModels}
                    pricing={pricing}
                />
            )}

            {/* Where tokens go — spend per area of the review process */}
            <AreaBreakdown rows={byArea} selectedModels={selectedModels} />

            {/* Per-model breakdown (collapsed by default) */}
            <ModelBreakdownTable
                rows={breakdownRows}
                pricing={filteredPricing}
            />
        </div>
    );
};
