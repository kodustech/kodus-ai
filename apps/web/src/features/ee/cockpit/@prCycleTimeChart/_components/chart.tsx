"use client";

import type { AwaitedReturnType } from "src/core/types";
import type { getLeadTimeForChange } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";
import {
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import {
    CHART_COLORS,
    formatHoursLabel,
    rechartsAxisProps,
    rechartsGridProps,
    RechartsTooltip,
} from "../../_components/charts/recharts-shared";

export const Chart = ({
    data,
}: {
    data: AwaitedReturnType<typeof getLeadTimeForChange>;
}) => {
    const chartData = data?.map((item) => ({
        week: item.weekStart,
        hours: item.leadTimeP75Hours,
    }));

    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart
                data={chartData}
                margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid {...rechartsGridProps} />
                <XAxis dataKey="week" tickMargin={8} {...rechartsAxisProps} />
                <YAxis tickFormatter={(v) => `${v}h`} {...rechartsAxisProps} />
                <Tooltip
                    cursor={{ fill: "#20203266" }}
                    content={
                        <RechartsTooltip
                            valueFormatter={(v) => formatHoursLabel(v)}
                        />
                    }
                />
                <Bar
                    dataKey="hours"
                    name="lead time (p75)"
                    fill={CHART_COLORS.success}
                    fillOpacity={0.85}
                    radius={[5, 5, 0, 0]}
                    maxBarSize={36}
                />
            </BarChart>
        </ResponsiveContainer>
    );
};
