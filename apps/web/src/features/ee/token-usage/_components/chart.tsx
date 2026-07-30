"use client";

import { useEffect, useMemo, useState } from "react";
import { BaseUsageContract, ModelPricingInfo } from "@services/usage/types";
import {
    Bar,
    CartesianGrid,
    ComposedChart,
    ResponsiveContainer,
    Scatter,
    Tooltip,
    XAxis,
    YAxis,
    type TooltipContentProps,
} from "recharts";
import { cn } from "src/core/utils/components";

import { rowCost } from "../_utils/cost";
import {
    CHART_COLORS,
    rechartsAxisProps,
    rechartsGridProps,
} from "../../cockpit/_components/charts/recharts-shared";

// Stacked bottom→top. Input is decomposed into uncached input + cache read
// so the (discounted) cache spend is visible, matching the KPI cards
// (Uncached input / Cache read / Output / Reasoning).
const SERIES = [
    { key: "input", label: "Input", color: CHART_COLORS.info },
    { key: "cacheRead", label: "Cache", color: CHART_COLORS.purple },
    { key: "output", label: "Output", color: CHART_COLORS.success },
    { key: "outputReasoning", label: "Reasoning", color: CHART_COLORS.warning },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

/**
 * Cockpit charts never scroll horizontally — series are bounded to fit the
 * container. Unbounded dimensions (PR/review/developer) show the top
 * consumers by total tokens.
 */
const TOP_N = 24;

type ChartRow = Record<SeriesKey, number> & {
    label: string;
    isCapped: boolean;
    /** Pre-cap values per series, for the tooltip. */
    original: Record<SeriesKey, number>;
    capMarker?: number;
};

const rowTotal = (d: Record<SeriesKey, number>) =>
    SERIES.reduce((sum, s) => sum + d[s.key], 0);

const formatTokens = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1000000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1000000).toFixed(1)}M`;
};

const formatUsd = (v: number) => {
    if (v === 0) return "$0";
    if (v < 0.01) return "<$0.01";
    if (v >= 1000) return `$${(v / 1000).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
};

export type ChartUnit = "tokens" | "usd";

const UsageTooltip = ({
    active,
    payload,
    label,
    formatLabel,
    formatValue = formatTokens,
}: Partial<TooltipContentProps<number, string>> & {
    formatLabel?: (label: string) => string;
    formatValue?: (value: number) => string;
}) => {
    if (!active || !payload?.length) return null;

    const row = payload[0]?.payload as ChartRow | undefined;
    if (!row) return null;

    // Show the REAL values (pre-cap); the bar heights may be scaled down.
    const originals = row.original;
    // Drop series that are zero for this bar (e.g. no cache on this run).
    const rows = SERIES.filter((s) => originals[s.key] > 0);

    return (
        <div className="bg-card-lv1 border-card-lv3 min-w-36 rounded-lg border px-3 py-2 shadow-xl">
            <div className="text-text-primary mb-1.5 text-xs font-semibold">
                {formatLabel ? formatLabel(String(label)) : label}
                {row.isCapped && (
                    <span className="text-warning ml-2 font-normal">
                        exceeds scale
                    </span>
                )}
            </div>
            {rows.map((series) => (
                <div
                    key={series.key}
                    className="text-text-secondary flex items-center gap-2 py-0.5 text-xs">
                    <span
                        className="size-2 shrink-0 rounded-xs"
                        style={{ backgroundColor: series.color }}
                    />
                    <span className="flex-1">{series.label}</span>
                    <span className="text-text-primary font-mono font-semibold">
                        {formatValue(originals[series.key])}
                    </span>
                </div>
            ))}
        </div>
    );
};

export const Chart = ({
    data,
    filterType,
    unit = "tokens",
    pricing = {},
}: {
    data: Array<
        BaseUsageContract & {
            prNumber?: number;
            developer?: string;
            date?: string;
            review?: string;
        }
    >;
    filterType: string;
    /** "usd" prices each row client-side with the same formula as the API. */
    unit?: ChartUnit;
    pricing?: Record<string, ModelPricingInfo>;
}) => {
    const [isMounted, setIsMounted] = useState(false);
    const [hidden, setHidden] = useState<Record<string, boolean>>({});

    useEffect(() => {
        setIsMounted(true);
    }, []);

    // Cockpit-style legend toggles — never allow hiding every series.
    const toggle = (key: SeriesKey) => {
        setHidden((prev) => {
            const next = { ...prev, [key]: !prev[key] };
            if (SERIES.every((s) => next[s.key])) return prev;
            return next;
        });
    };

    const xAccessor = useMemo(() => {
        switch (filterType) {
            case "daily":
                return "date" as const;
            case "by-pr":
                return "prNumber" as const;
            case "by-developer":
                return "developer" as const;
            case "by-review":
                return "review" as const;
            default:
                return "date" as const;
        }
    }, [filterType]);

    // Rows arrive one-per-model — merge them per x value. Both modes split
    // input into uncached + cache read and output into output + reasoning, so
    // the four disjoint series still sum to the true total (no double count).
    const transformedData = useMemo(() => {
        const seriesValues = (
            d: (typeof data)[number],
        ): Record<SeriesKey, number> => {
            if (unit === "usd") {
                const cost = rowCost(d, pricing[d.model]);
                return {
                    input: cost.uncachedInput,
                    cacheRead: cost.cacheRead,
                    output: cost.output,
                    outputReasoning: cost.reasoning,
                };
            }
            const cacheRead = d.cacheRead ?? 0;
            const reasoning = d.outputReasoning || 0;
            return {
                input: Math.max(0, (d.input || 0) - cacheRead),
                cacheRead,
                output: Math.max(0, (d.output || 0) - reasoning),
                outputReasoning: reasoning,
            };
        };

        const merged: Record<string, ChartRow> = {};
        data.forEach((d) => {
            const key =
                filterType === "by-pr"
                    ? `#${d[xAccessor]}`
                    : String(d[xAccessor]);
            const v = seriesValues(d);

            if (!merged[key]) {
                merged[key] = {
                    label: key,
                    ...v,
                    isCapped: false,
                    original: { ...v },
                };
            } else {
                for (const s of SERIES) {
                    merged[key][s.key] += v[s.key];
                    merged[key].original[s.key] = merged[key][s.key];
                }
            }
        });

        return Object.values(merged);
    }, [data, filterType, xAccessor, unit, pricing]);

    // Cockpit charts never scroll — they bound the series to the container.
    // Daily is bounded by the date range; the categorical dimensions
    // (PR/review/developer) are unbounded, so show the TOP consumers by
    // total tokens, which is the question this screen answers.
    const isTopN = filterType !== "daily";
    const { boundedData, droppedCount } = useMemo(() => {
        if (!isTopN || transformedData.length <= TOP_N) {
            return { boundedData: transformedData, droppedCount: 0 };
        }
        const sorted = [...transformedData].sort(
            (a, b) => rowTotal(b) - rowTotal(a),
        );
        return {
            boundedData: sorted.slice(0, TOP_N),
            droppedCount: transformedData.length - TOP_N,
        };
    }, [transformedData, isTopN]);

    // Outlier cap: when the max bar dwarfs the p95, scale outliers down to
    // 1.2×p95 so the rest of the chart stays readable; capped bars keep their
    // real values for the tooltip and get a marker dot at the top.
    const { maxDomain, chartData } = useMemo(() => {
        const totals = boundedData.map(rowTotal);

        if (totals.length === 0) {
            return { maxDomain: undefined, chartData: boundedData };
        }

        const sortedTotals = [...totals].sort((a, b) => a - b);
        const percentile95Index = Math.floor(sortedTotals.length * 0.95);
        const percentile95 = sortedTotals[percentile95Index];
        const maxValue = sortedTotals[sortedTotals.length - 1];

        if (maxValue <= percentile95 * 3) {
            return { maxDomain: undefined, chartData: boundedData };
        }

        const capLimit = percentile95 * 1.2;
        const cappedData = boundedData.map((d) => {
            const total = rowTotal(d);
            if (total <= capLimit) return d;

            const ratio = capLimit / total;
            const scaled: ChartRow = {
                ...d,
                isCapped: true,
                capMarker: capLimit * 0.98,
            };
            for (const s of SERIES) scaled[s.key] = d[s.key] * ratio;
            return scaled;
        });

        return { maxDomain: capLimit, chartData: cappedData };
    }, [boundedData]);

    const formatValue = unit === "usd" ? formatUsd : formatTokens;

    // Tooltip shows the full label; the axis truncates long ones
    // (by-review's "#PR · shortId").
    const formatLabel = (x: string) => {
        if (filterType === "daily") {
            return new Date(x).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
            });
        }
        return x;
    };
    const formatXTick = (x: string) => {
        const label = formatLabel(x);
        return label.length > 12 ? `${label.slice(0, 11)}…` : label;
    };

    if (!isMounted) {
        return <div className="h-full w-full" />;
    }

    return (
        <div className="flex h-full w-full flex-col gap-4">
            {droppedCount > 0 && (
                <p className="text-text-tertiary text-xs">
                    Showing the top {TOP_N} of {TOP_N + droppedCount} by total
                    tokens. Narrow the date range or filters to see the rest.
                </p>
            )}
            <div className="min-h-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                        data={chartData}
                        margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
                        <CartesianGrid {...rechartsGridProps} />
                        {/* Auto tick skipping (cockpit convention):
                                dense dimensions show a readable subset of
                                labels; every bar stays hoverable and the
                                tooltip carries the full identity. */}
                        <XAxis
                            dataKey="label"
                            tickMargin={8}
                            minTickGap={24}
                            tickFormatter={(value) =>
                                formatXTick(String(value))
                            }
                            {...rechartsAxisProps}
                        />
                        <YAxis
                            domain={maxDomain ? [0, maxDomain] : [0, "auto"]}
                            allowDataOverflow={Boolean(maxDomain)}
                            tickFormatter={(value) =>
                                formatValue(Number(value))
                            }
                            {...rechartsAxisProps}
                        />
                        <Tooltip
                            cursor={{ fill: "#20203266" }}
                            content={
                                <UsageTooltip
                                    formatLabel={formatLabel}
                                    formatValue={formatValue}
                                />
                            }
                        />
                        {SERIES.map((series, i) => (
                            <Bar
                                key={series.key}
                                dataKey={series.key}
                                name={series.label}
                                stackId="tokens"
                                hide={hidden[series.key]}
                                fill={series.color}
                                maxBarSize={28}
                                radius={
                                    i === 0
                                        ? [0, 0, 5, 5]
                                        : i === SERIES.length - 1
                                          ? [5, 5, 0, 0]
                                          : undefined
                                }
                            />
                        ))}
                        {maxDomain && (
                            <Scatter
                                dataKey="capMarker"
                                name="Exceeds scale"
                                fill={CHART_COLORS.primary}
                                shape={(props: any) =>
                                    typeof props.cy === "number" ? (
                                        <circle
                                            cx={props.cx}
                                            cy={props.cy}
                                            r={4}
                                            fill={CHART_COLORS.primary}
                                            stroke="#1f2937"
                                            strokeWidth={2}
                                        />
                                    ) : (
                                        <g />
                                    )
                                }
                            />
                        )}
                    </ComposedChart>
                </ResponsiveContainer>
            </div>

            <div className="flex items-center gap-5">
                {SERIES.map((series) => (
                    <button
                        key={series.key}
                        type="button"
                        onClick={() => toggle(series.key)}
                        className="flex cursor-pointer items-center gap-2 text-xs">
                        <span
                            style={{ backgroundColor: series.color }}
                            className={cn(
                                "size-3 rounded-full",
                                hidden[series.key] && "bg-text-tertiary!",
                            )}
                        />
                        {series.label}
                    </button>
                ))}
                {maxDomain && (
                    <span className="text-warning ml-auto flex items-center gap-2 text-xs">
                        <span className="bg-warning size-2 rounded-full" />
                        Some values exceed the scale — hover for actual values.
                    </span>
                )}
            </div>
        </div>
    );
};
