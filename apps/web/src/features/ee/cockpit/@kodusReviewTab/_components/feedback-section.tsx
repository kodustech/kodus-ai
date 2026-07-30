"use client";

import { useRouter } from "next/navigation";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import { COCKPIT_REVIEW_PARAM } from "../../_constants";
import { useShallowParam } from "../../_helpers/use-shallow-param";
import type {
    NegativeFeedbackByCategoryRow,
    NegativeFeedbackWeeklyRow,
} from "../../_services/analytics/review/fetch";
import { ChartTooltip } from "./chart-tooltip";
import { TogglePills } from "./toggle-pills";

const axisProps = {
    stroke: "transparent",
    tick: { fill: "#f3f3f780", fontSize: 11 },
    tickLine: false,
} as const;

type Mode = "category" | "trend";

const CategoryBars = ({
    data,
}: {
    data: NegativeFeedbackByCategoryRow[];
}) => {
    const router = useRouter();
    const withDownvotes = data.filter((r) => r.thumbsDown > 0);

    if (!withDownvotes.length) {
        return (
            <div className="text-text-tertiary flex h-48 items-center justify-center text-sm">
                No negative feedback in this period 🎉
            </div>
        );
    }

    const max = Math.max(...withDownvotes.map((r) => r.thumbsDown));

    return (
        <div className="flex flex-col gap-1.5">
            {withDownvotes.map((row) => (
                <button
                    key={row.category}
                    type="button"
                    onClick={() =>
                        router.push(
                            `/review-suggestions?category=${encodeURIComponent(row.category)}`,
                        )
                    }
                    className="hover:bg-card-lv3 group flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors">
                    <span className="text-text-secondary group-hover:text-primary-light flex w-36 shrink-0 items-center gap-1 truncate text-xs transition-colors">
                        {row.category}
                        <span className="opacity-0 transition-opacity group-hover:opacity-100">
                            →
                        </span>
                    </span>
                    <span className="bg-card-lv3/40 relative h-3 flex-1 overflow-hidden rounded-sm">
                        <span
                            className="bg-danger/80 absolute inset-y-0 left-0 rounded-sm"
                            style={{
                                width: `${(row.thumbsDown / max) * 100}%`,
                            }}
                        />
                    </span>
                    <span className="text-text-tertiary w-24 shrink-0 text-right font-mono text-xs whitespace-nowrap">
                        ▼ {row.thumbsDown} · ▲ {row.thumbsUp}
                    </span>
                </button>
            ))}
        </div>
    );
};

const TrendChart = ({ data }: { data: NegativeFeedbackWeeklyRow[] }) => {
    if (!data.length) return <CockpitNoDataPlaceholder />;

    const chartData = data.map((w) => ({
        week: w.weekStart,
        "👎": w.thumbsDown,
    }));

    return (
        <ResponsiveContainer width="100%" height={224}>
            <AreaChart
                data={chartData}
                margin={{ top: 10, right: 12, left: -20, bottom: 0 }}>
                <defs>
                    <linearGradient id="fillDowns" x1="0" y1="0" x2="0" y2="1">
                        <stop
                            offset="5%"
                            stopColor="#fa5867"
                            stopOpacity={0.4}
                        />
                        <stop
                            offset="95%"
                            stopColor="#fa5867"
                            stopOpacity={0.02}
                        />
                    </linearGradient>
                </defs>
                <CartesianGrid
                    vertical={false}
                    strokeDasharray="3 3"
                    stroke="#30304b88"
                />
                <XAxis dataKey="week" tickMargin={10} {...axisProps} />
                <YAxis allowDecimals={false} {...axisProps} />
                <Tooltip
                    cursor={{ stroke: "#30304b", strokeDasharray: "3 3" }}
                    content={<ChartTooltip />}
                />
                <Area
                    type="monotone"
                    dataKey="👎"
                    stroke="#fa5867"
                    strokeWidth={2.5}
                    fill="url(#fillDowns)"
                    dot={false}
                    activeDot={{
                        r: 4,
                        fill: "#fa5867",
                        stroke: "#181825",
                        strokeWidth: 2,
                    }}
                />
            </AreaChart>
        </ResponsiveContainer>
    );
};

export const FeedbackSection = ({
    byCategory,
    weekly,
}: {
    byCategory: NegativeFeedbackByCategoryRow[];
    weekly: NegativeFeedbackWeeklyRow[];
}) => {
    const [mode, setMode] = useShallowParam<Mode>(
        COCKPIT_REVIEW_PARAM.feedbackMode,
        "category",
        ["category", "trend"],
    );

    return (
        <Card color="lv1">
            <CardHeader className="flex-row items-start justify-between">
                <div className="flex flex-col gap-1.5">
                    <CardTitle className="text-sm">
                        Negative feedback (👎)
                    </CardTitle>
                    <CardDescription className="text-xs">
                        where the team disagrees with Kodus · click to drill
                        down
                    </CardDescription>
                </div>
                <TogglePills<Mode>
                    value={mode}
                    onChange={setMode}
                    options={[
                        { value: "category", label: "By category" },
                        { value: "trend", label: "Trend" },
                    ]}
                />
            </CardHeader>
            <CardContent>
                {mode === "category" ? (
                    <CategoryBars data={byCategory} />
                ) : (
                    <TrendChart data={weekly} />
                )}
            </CardContent>
        </Card>
    );
};
