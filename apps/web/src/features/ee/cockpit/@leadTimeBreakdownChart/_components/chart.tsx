"use client";

import { useState } from "react";
import {
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { AwaitedReturnType } from "src/core/types";
import { cn } from "src/core/utils/components";
import type { getLeadTimeBreakdown } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";

import {
    CHART_COLORS,
    formatHoursLabel,
    rechartsAxisProps,
    rechartsGridProps,
    RechartsTooltip,
} from "../../_components/charts/recharts-shared";

const series = [
    { key: "coding", name: "Coding Time", fill: CHART_COLORS.danger },
    { key: "pickup", name: "Pickup Time", fill: CHART_COLORS.warning },
    { key: "review", name: "Review Time", fill: CHART_COLORS.success },
] as const;

export const Chart = ({
    data,
}: {
    data: AwaitedReturnType<typeof getLeadTimeBreakdown>;
}) => {
    const [hidden, setHidden] = useState<Record<string, boolean>>({});

    const chartData = data?.map((item) => ({
        week: item.weekStart,
        coding: item.codingTimeHours,
        pickup: item.pickupTimeHours,
        review: item.reviewTimeHours,
    }));

    const toggle = (key: string) => {
        setHidden((prev) => {
            const next = { ...prev, [key]: !prev[key] };
            // keep at least one series visible
            if (series.every((s) => next[s.key])) return prev;
            return next;
        });
    };

    return (
        <div className="flex h-full w-full flex-col gap-4">
            <div className="min-h-0 w-full flex-1">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                        data={chartData}
                        margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
                        <CartesianGrid {...rechartsGridProps} />
                        <XAxis
                            dataKey="week"
                            tickMargin={8}
                            {...rechartsAxisProps}
                        />
                        <YAxis
                            tickFormatter={(v) => `${v}h`}
                            {...rechartsAxisProps}
                        />
                        <Tooltip
                            cursor={{ fill: "#20203266" }}
                            content={
                                <RechartsTooltip
                                    hideZero
                                    valueFormatter={(v) => formatHoursLabel(v)}
                                />
                            }
                        />
                        {series.map((s) => (
                            <Bar
                                key={s.key}
                                stackId="lead"
                                dataKey={s.key}
                                name={s.name}
                                hide={hidden[s.key]}
                                fill={s.fill}
                                maxBarSize={28}
                            />
                        ))}
                    </BarChart>
                </ResponsiveContainer>
            </div>

            <div className="flex items-center gap-5">
                {series.map((s) => (
                    <button
                        key={s.key}
                        type="button"
                        onClick={() => toggle(s.key)}
                        className="flex cursor-pointer items-center gap-2 text-xs">
                        <span
                            style={{ backgroundColor: s.fill }}
                            className={cn(
                                "size-3 rounded-full",
                                hidden[s.key] && "bg-text-tertiary!",
                            )}
                        />
                        {s.name}
                    </button>
                ))}
            </div>
        </div>
    );
};
