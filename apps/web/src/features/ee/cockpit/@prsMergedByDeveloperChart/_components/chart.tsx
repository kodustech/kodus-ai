"use client";

import colorSeed from "seed-color";
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
import { pluralize } from "src/core/utils/string";
import type { getPRsByDeveloper } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";

import {
    rechartsAxisProps,
    rechartsGridProps,
    RechartsTooltip,
} from "../../_components/charts/recharts-shared";

export const Chart = ({
    data,
}: {
    data: AwaitedReturnType<typeof getPRsByDeveloper>;
}) => {
    // Pivot [{weekStart, author, prCount}] → one row per week with a
    // column per author, so authors stack within each week's bar.
    const authors = Array.from(new Set(data?.map((d) => d.author) ?? []));
    const byWeek = new Map<string, Record<string, number | string>>();
    for (const item of data ?? []) {
        const row = byWeek.get(item.weekStart) ?? { week: item.weekStart };
        row[item.author] = item.prCount;
        byWeek.set(item.weekStart, row);
    }
    const chartData = [...byWeek.values()];

    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart
                data={chartData}
                margin={{ top: 10, right: 12, left: -16, bottom: 0 }}>
                <CartesianGrid {...rechartsGridProps} />
                <XAxis dataKey="week" tickMargin={8} {...rechartsAxisProps} />
                <YAxis allowDecimals={false} {...rechartsAxisProps} />
                <Tooltip
                    cursor={{ fill: "#20203266" }}
                    content={
                        <RechartsTooltip
                            hideZero
                            valueFormatter={(v) =>
                                `${v} ${pluralize(v, {
                                    singular: "PR",
                                    plural: "PRs",
                                })}`
                            }
                        />
                    }
                />
                {authors.map((author) => (
                    <Bar
                        key={author}
                        stackId="devs"
                        dataKey={author}
                        name={author}
                        fill={colorSeed(author).toHex()}
                        maxBarSize={28}
                    />
                ))}
            </BarChart>
        </ResponsiveContainer>
    );
};
