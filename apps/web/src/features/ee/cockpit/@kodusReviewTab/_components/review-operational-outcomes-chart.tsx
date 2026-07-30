"use client";

import {
    Bar,
    BarChart as RechartsBarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";

import { PercentageDiff } from "../../_components/percentage-diff";
import {
    CHART_COLORS,
    rechartsAxisProps,
    rechartsGridProps,
} from "../../_components/charts/recharts-shared";
import type {
    ReviewOperationalMetrics,
    ReviewOperationalMetricsWeeklyRow,
} from "../../_services/analytics/review/fetch";

type Trend = "improved" | "worsened" | "unchanged";
type TrendMode = React.ComponentProps<typeof PercentageDiff>["mode"];
type OutcomeKey = "successful" | "error" | "skipped";
type ChartRow = Record<OutcomeKey, number> &
    Record<`${OutcomeKey}Count`, number> & {
        period: string;
        total: number;
    };

const count = (value: number) => Intl.NumberFormat("en-US").format(value);
const pct = (value: number) => `${Math.round(value * 100)}%`;
const pctFromWholeNumber = (value: number) => `${Math.round(value)}%`;
const ratioToPct = (value: number, total: number) =>
    total > 0 ? (value / total) * 100 : 0;
const formatWeekTick = (value: string) => {
    const [, month, day] = value.split("-");
    return month && day ? `${month}/${day}` : value;
};

const outcomeMeta: Record<
    OutcomeKey,
    { label: string; color: string; countKey: `${OutcomeKey}Count` }
> = {
    successful: {
        label: "Success",
        color: CHART_COLORS.success,
        countKey: "successfulCount",
    },
    error: {
        label: "Error",
        color: CHART_COLORS.danger,
        countKey: "errorCount",
    },
    skipped: {
        label: "Skipped",
        color: CHART_COLORS.warning,
        countKey: "skippedCount",
    },
};

const trendStatus = (trend: Trend) => {
    if (trend === "improved") return "good";
    if (trend === "worsened") return "bad";
    return "neutral";
};

const Delta = ({
    value,
    unit,
    trend,
    mode,
}: {
    value: number;
    unit: "%" | "pp";
    trend: Trend;
    mode: TrendMode;
}) => (
    <PercentageDiff mode={mode} status={trendStatus(trend)}>
        {Math.abs(value)}
        {unit === "pp" ? " pp" : "%"}
    </PercentageDiff>
);

const OutcomesTooltip = ({
    active,
    payload,
    label,
}: TooltipContentProps<number, string>) => {
    if (!active || !payload?.length) return null;

    const row = payload[0]?.payload as ChartRow | undefined;
    if (!row) return null;

    const rows = payload.filter((entry) => (entry.value as number) > 0);
    if (!rows.length) return null;

    return (
        <div className="bg-card-lv1 border-card-lv3 min-w-40 rounded-lg border px-3 py-2 shadow-xl">
            <div className="text-text-primary mb-1.5 flex items-center justify-between gap-4 text-xs font-semibold">
                <span>{label}</span>
                <span className="text-text-tertiary font-mono">
                    {count(row.total)}
                </span>
            </div>
            {rows.map((entry) => {
                const key = String(entry.dataKey) as OutcomeKey;
                const meta = outcomeMeta[key];
                const rawCount = meta ? row[meta.countKey] : 0;

                return (
                    <div
                        key={key}
                        className="text-text-secondary flex items-center gap-2 py-0.5 text-xs">
                        <span
                            className="size-2 shrink-0 rounded-xs"
                            style={{ backgroundColor: meta?.color }}
                        />
                        <span className="flex-1">{meta?.label ?? key}</span>
                        <span className="text-text-primary font-mono font-semibold">
                            {pctFromWholeNumber(entry.value as number)}
                        </span>
                        <span className="text-text-tertiary font-mono">
                            {count(rawCount)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
};

export const ReviewOperationalOutcomesChart = ({
    metrics,
    weekly,
}: {
    metrics: ReviewOperationalMetrics;
    weekly: ReviewOperationalMetricsWeeklyRow[];
}) => {
    const { currentPeriod, previousPeriod, comparison } = metrics;
    const chartData = weekly.map((week) => ({
        period: week.weekStart,
        total: week.processedReviews,
        successful: ratioToPct(week.successfulReviews, week.processedReviews),
        error: ratioToPct(week.errorReviews, week.processedReviews),
        skipped: ratioToPct(week.skippedReviews, week.processedReviews),
        successfulCount: week.successfulReviews,
        errorCount: week.errorReviews,
        skippedCount: week.skippedReviews,
    })) satisfies ChartRow[];

    const outcomes = [
        {
            label: "Success",
            color: CHART_COLORS.success,
            count: currentPeriod.successfulReviews,
            rate: currentPeriod.successRate,
            delta: comparison.successRate.percentagePointChange,
            trend: comparison.successRate.trend,
            mode: "higher-is-better" as const,
        },
        {
            label: "Error",
            color: CHART_COLORS.danger,
            count: currentPeriod.errorReviews,
            rate: currentPeriod.errorRate,
            delta: comparison.errorRate.percentagePointChange,
            trend: comparison.errorRate.trend,
            mode: "lower-is-better" as const,
        },
        {
            label: "Skipped",
            color: CHART_COLORS.warning,
            count: currentPeriod.skippedReviews,
            rate: currentPeriod.skippedRate,
            delta: comparison.skippedRate.percentagePointChange,
            trend: comparison.skippedRate.trend,
            mode: "lower-is-better" as const,
        },
    ];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <div className="text-text-secondary text-xs font-semibold">
                        Reviews processed
                    </div>
                    <div className="mt-1 flex items-baseline gap-3">
                        <span className="text-2xl font-bold">
                            {count(currentPeriod.processedReviews)}
                        </span>
                        <span className="text-text-tertiary text-xs">
                            {count(previousPeriod.processedReviews)} previous
                        </span>
                    </div>
                </div>
                <div className="flex justify-end text-xs font-semibold">
                    <Delta
                        value={comparison.processedReviews.percentageChange}
                        unit="%"
                        trend={comparison.processedReviews.trend}
                        mode="higher-is-better"
                    />
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <ResponsiveContainer width="100%" height={240}>
                    <RechartsBarChart
                        data={chartData}
                        margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                        <CartesianGrid {...rechartsGridProps} />
                        <XAxis
                            dataKey="period"
                            tickMargin={10}
                            tickFormatter={(value) =>
                                formatWeekTick(String(value))
                            }
                            {...rechartsAxisProps}
                        />
                        <YAxis
                            domain={[0, 100]}
                            ticks={[0, 25, 50, 75, 100]}
                            tickFormatter={(value) => `${Number(value)}%`}
                            {...rechartsAxisProps}
                        />
                        <Tooltip
                            cursor={{ fill: "#30304b22" }}
                            content={<OutcomesTooltip />}
                        />
                        <Bar
                            dataKey="successful"
                            name="Success"
                            stackId="reviews"
                            fill={CHART_COLORS.success}
                            radius={[0, 0, 5, 5]}
                        />
                        <Bar
                            dataKey="error"
                            name="Error"
                            stackId="reviews"
                            fill={CHART_COLORS.danger}
                        />
                        <Bar
                            dataKey="skipped"
                            name="Skipped"
                            stackId="reviews"
                            fill={CHART_COLORS.warning}
                            radius={[5, 5, 0, 0]}
                        />
                    </RechartsBarChart>
                </ResponsiveContainer>

                <div className="divide-card-lv3/70 flex flex-col justify-center divide-y">
                    {outcomes.map((outcome) => (
                        <div
                            key={outcome.label}
                            className="flex items-center justify-between gap-4 py-2">
                            <div className="min-w-0">
                                <div className="text-text-secondary flex items-center gap-2 text-xs font-semibold">
                                    <span
                                        className="size-2 rounded-xs"
                                        style={{
                                            backgroundColor: outcome.color,
                                        }}
                                    />
                                    {outcome.label}
                                </div>
                                <div className="text-text-tertiary mt-1 text-xs">
                                    {count(outcome.count)} reviews
                                </div>
                            </div>
                            <div className="text-right">
                                <div className="text-sm font-bold">
                                    {pct(outcome.rate)}
                                </div>
                                <div className="mt-1 flex justify-end text-xs font-semibold">
                                    <Delta
                                        value={outcome.delta}
                                        unit="pp"
                                        trend={outcome.trend}
                                        mode={outcome.mode}
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
