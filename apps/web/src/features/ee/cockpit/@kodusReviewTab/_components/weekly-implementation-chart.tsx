"use client";

import {
    Area,
    AreaChart,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import { COCKPIT_REVIEW_PARAM } from "../../_constants";
import { useShallowParam } from "../../_helpers/use-shallow-param";
import type { ImplementationRateWeeklyRow } from "../../_services/analytics/review/fetch";
import { ChartTooltip } from "./chart-tooltip";
import { SEVERITY_COLORS, SEVERITY_ORDER } from "./chart-constants";
import { TogglePills } from "./toggle-pills";

type Mode = "overall" | "severity";

const axisProps = {
    stroke: "transparent",
    tick: { fill: "#f3f3f780", fontSize: 11 },
    tickLine: false,
} as const;

export const WeeklyImplementationChart = ({
    data,
}: {
    data: ImplementationRateWeeklyRow[];
}) => {
    const [mode, setMode] = useShallowParam<Mode>(
        COCKPIT_REVIEW_PARAM.weeklyMode,
        "overall",
        ["overall", "severity"],
    );

    if (!data.length) return <CockpitNoDataPlaceholder />;

    const severities = SEVERITY_ORDER.filter((severity) =>
        data.some((w) => w.bySeverity[severity]),
    );

    const chartData = data.map((w) => ({
        week: w.weekStart,
        rate: Math.round(w.rate * 100),
        ...Object.fromEntries(
            severities.map((s) => [
                s,
                Math.round((w.bySeverity[s]?.rate ?? 0) * 100),
            ]),
        ),
    }));

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-end">
                <TogglePills<Mode>
                    value={mode}
                    onChange={setMode}
                    options={[
                        { value: "overall", label: "Overall" },
                        { value: "severity", label: "By severity" },
                    ]}
                />
            </div>

            <ResponsiveContainer width="100%" height={288}>
                {mode === "overall" ? (
                    <AreaChart
                        data={chartData}
                        margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
                        <defs>
                            <linearGradient
                                id="fillRate"
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1">
                                <stop
                                    offset="5%"
                                    stopColor="#f8b76d"
                                    stopOpacity={0.45}
                                />
                                <stop
                                    offset="95%"
                                    stopColor="#f8b76d"
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
                        <YAxis
                            domain={[0, 100]}
                            tickFormatter={(v) => `${v}%`}
                            {...axisProps}
                        />
                        <Tooltip
                            cursor={{
                                stroke: "#30304b",
                                strokeDasharray: "3 3",
                            }}
                            content={<ChartTooltip unit="%" />}
                        />
                        <Area
                            type="monotone"
                            dataKey="rate"
                            name="impl. rate"
                            stroke="#f8b76d"
                            strokeWidth={2.5}
                            fill="url(#fillRate)"
                            dot={false}
                            activeDot={{
                                r: 4,
                                fill: "#f8b76d",
                                stroke: "#181825",
                                strokeWidth: 2,
                            }}
                        />
                    </AreaChart>
                ) : (
                    <LineChart
                        data={chartData}
                        margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
                        <CartesianGrid
                            vertical={false}
                            strokeDasharray="3 3"
                            stroke="#30304b88"
                        />
                        <XAxis dataKey="week" tickMargin={10} {...axisProps} />
                        <YAxis
                            domain={[0, 100]}
                            tickFormatter={(v) => `${v}%`}
                            {...axisProps}
                        />
                        <Tooltip
                            cursor={{
                                stroke: "#30304b",
                                strokeDasharray: "3 3",
                            }}
                            content={<ChartTooltip unit="%" />}
                        />
                        {severities.map((severity) => (
                            <Line
                                key={severity}
                                type="monotone"
                                dataKey={severity}
                                name={severity}
                                stroke={SEVERITY_COLORS[severity]}
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 3.5 }}
                            />
                        ))}
                    </LineChart>
                )}
            </ResponsiveContainer>

            {mode === "severity" && (
                <div className="text-text-secondary flex justify-center gap-4 text-xs">
                    {severities.map((severity) => (
                        <span
                            key={severity}
                            className="flex items-center gap-1.5 capitalize">
                            <span
                                className="size-2 rounded-xs"
                                style={{
                                    backgroundColor: SEVERITY_COLORS[severity],
                                }}
                            />
                            {severity}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};
