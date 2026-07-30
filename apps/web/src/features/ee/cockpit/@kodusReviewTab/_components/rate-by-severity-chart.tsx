"use client";

import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    LabelList,
    ResponsiveContainer,
    Tooltip,
    type TooltipContentProps,
    XAxis,
    YAxis,
} from "recharts";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import { COCKPIT_REVIEW_PARAM } from "../../_constants";
import { useShallowParam } from "../../_helpers/use-shallow-param";
import type { ImplementationRateBySeverityRow } from "../../_services/analytics/review/fetch";
import { SEVERITY_COLORS } from "./chart-constants";
import { TogglePills } from "./toggle-pills";

const axisProps = {
    stroke: "transparent",
    tick: { fill: "#f3f3f780", fontSize: 11 },
    tickLine: false,
} as const;

type Source = "all" | "native";

// Below this many sent suggestions the rate is statistical noise — render
// the bar faded and call it out, so a 0%/100% from a sample of 1 doesn't
// read as a real signal.
const LOW_SAMPLE = 5;

type Datum = {
    severity: string;
    rate: number;
    sent: number;
    implemented: number;
    fill: string;
    lowSample: boolean;
};

const SeverityTooltip = ({
    active,
    payload,
}: TooltipContentProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload as Datum;
    return (
        <div className="bg-card-lv1 border-card-lv3 rounded-lg border px-3 py-2 shadow-xl">
            <div className="text-text-primary mb-1 text-xs font-semibold capitalize">
                {d.severity}
            </div>
            <div className="text-text-secondary font-mono text-xs">
                {d.rate}% · {d.implemented}/{d.sent} implemented
            </div>
            {d.lowSample && (
                <div className="text-warning mt-1 text-[11px]">
                    low sample — not reliable
                </div>
            )}
        </div>
    );
};

export const RateBySeverityChart = ({
    data,
}: {
    data: ImplementationRateBySeverityRow[];
}) => {
    const [source, setSource] = useShallowParam<Source>(
        COCKPIT_REVIEW_PARAM.severitySource,
        "all",
        ["all", "native"],
    );

    if (!data.length) return <CockpitNoDataPlaceholder />;

    const chartData: Datum[] = data.map((row) => {
        const sent = source === "all" ? row.sent : row.nativeSent;
        const implemented =
            source === "all" ? row.implemented : row.nativeImplemented;
        const rate = source === "all" ? row.rate : row.nativeRate;
        return {
            severity: row.severity,
            rate: Math.round(rate * 100),
            sent,
            implemented,
            fill: SEVERITY_COLORS[row.severity] ?? SEVERITY_COLORS.unknown,
            lowSample: sent < LOW_SAMPLE,
        };
    });

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-end">
                <TogglePills<Source>
                    value={source}
                    onChange={setSource}
                    options={[
                        { value: "all", label: "All" },
                        { value: "native", label: "Kodus only" },
                    ]}
                />
            </div>

            <ResponsiveContainer width="100%" height={256}>
                <BarChart
                    data={chartData}
                    margin={{ top: 24, right: 12, left: -12, bottom: 0 }}>
                    <CartesianGrid
                        vertical={false}
                        strokeDasharray="3 3"
                        stroke="#30304b88"
                    />
                    <XAxis
                        dataKey="severity"
                        tickMargin={8}
                        className="capitalize"
                        {...axisProps}
                    />
                    <YAxis
                        domain={[0, 100]}
                        tickFormatter={(v) => `${v}%`}
                        {...axisProps}
                    />
                    <Tooltip
                        cursor={{ fill: "#20203266" }}
                        content={<SeverityTooltip />}
                    />
                    <Bar dataKey="rate" name="implemented" radius={[5, 5, 0, 0]}>
                        <LabelList
                            dataKey={(d: Datum) =>
                                d.lowSample ? `${d.rate}%*` : `${d.rate}%`
                            }
                            position="top"
                            fill="#cdcddf"
                            fontSize={11}
                            fontWeight={600}
                        />
                        {chartData.map((entry) => (
                            <Cell
                                key={entry.severity}
                                fill={entry.fill}
                                fillOpacity={entry.lowSample ? 0.3 : 0.85}
                            />
                        ))}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>

            <p className="text-text-tertiary px-1 text-[11px]">
                {source === "native"
                    ? "Excluding Kody Rules — their severity is set on the rule, not by Kodus's risk analysis."
                    : "Includes Kody Rules. Switch to “Kodus only” for Kodus's own severity calibration."}
                {chartData.some((d) => d.lowSample) &&
                    " * faded bars have too few suggestions to be reliable."}
            </p>
        </div>
    );
};
