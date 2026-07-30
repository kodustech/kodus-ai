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
import type { getPRsOpenedVsClosed } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";

import {
    CHART_COLORS,
    rechartsAxisProps,
    rechartsGridProps,
    RechartsTooltip,
} from "../../_components/charts/recharts-shared";

const series = [
    { key: "opened", name: "Opened", fill: CHART_COLORS.success },
    { key: "closed", name: "Closed", fill: CHART_COLORS.danger },
] as const;

export const Chart = ({
    data,
}: {
    data: AwaitedReturnType<typeof getPRsOpenedVsClosed>;
}) => {
    const [hidden, setHidden] = useState<Record<string, boolean>>({});

    const chartData = data?.map((item) => ({
        week: item.weekStart,
        opened: item.openedCount,
        closed: item.closedCount,
    }));

    const toggle = (key: string) => {
        setHidden((prev) => {
            const next = { ...prev, [key]: !prev[key] };
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
                        margin={{ top: 10, right: 12, left: -16, bottom: 0 }}>
                        <CartesianGrid {...rechartsGridProps} />
                        <XAxis
                            dataKey="week"
                            tickMargin={8}
                            {...rechartsAxisProps}
                        />
                        <YAxis
                            allowDecimals={false}
                            {...rechartsAxisProps}
                        />
                        <Tooltip
                            cursor={{ fill: "#20203266" }}
                            content={<RechartsTooltip hideZero />}
                        />
                        {series.map((s) => (
                            <Bar
                                key={s.key}
                                stackId="prs"
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
