"use client";

import type { TooltipContentProps } from "recharts";

/** Brand palette shared by the recharts-based cockpit charts. */
export const CHART_COLORS = {
    primary: "#f8b76d",
    success: "#42be65",
    danger: "#fa5867",
    warning: "#ff8b40",
    info: "#5190ff",
    purple: "#6a57a4",
    muted: "#cdcddf",
} as const;

export const rechartsAxisProps = {
    stroke: "transparent",
    tick: { fill: "#f3f3f780", fontSize: 11 },
    tickLine: false,
} as const;

export const rechartsGridProps = {
    vertical: false as const,
    strokeDasharray: "3 3",
    stroke: "#30304b88",
};

/**
 * shadcn-style floating tooltip: dark card + a colored swatch per series.
 * `valueFormatter` lets each chart render hours, counts, percentages…
 */
export const RechartsTooltip = ({
    active,
    payload,
    label,
    labelFormatter,
    valueFormatter,
    hideZero = false,
}: Partial<TooltipContentProps<number, string>> & {
    labelFormatter?: (label: string) => string;
    valueFormatter?: (value: number, name: string) => string;
    /** Drop series with a 0 value (handy for stacked bars). */
    hideZero?: boolean;
}) => {
    if (!active || !payload?.length) return null;

    const rows = hideZero
        ? payload.filter((entry) => (entry.value as number) !== 0)
        : payload;
    if (!rows.length) return null;

    return (
        <div className="bg-card-lv1 border-card-lv3 min-w-36 rounded-lg border px-3 py-2 shadow-xl">
            <div className="text-text-primary mb-1.5 text-xs font-semibold">
                {labelFormatter ? labelFormatter(String(label)) : label}
            </div>
            {rows.map((entry, i) => (
                <div
                    key={i}
                    className="text-text-secondary flex items-center gap-2 py-0.5 text-xs">
                    <span
                        className="size-2 shrink-0 rounded-xs"
                        style={{ backgroundColor: entry.color }}
                    />
                    <span className="flex-1 capitalize">{entry.name}</span>
                    <span className="text-text-primary font-mono font-semibold">
                        {valueFormatter
                            ? valueFormatter(
                                  entry.value as number,
                                  String(entry.name),
                              )
                            : entry.value}
                    </span>
                </div>
            ))}
        </div>
    );
};

export const formatHoursLabel = (hours: number) => {
    const h = Math.trunc(hours);
    const m = Math.trunc(60 * (hours - h));
    return `${h}h ${m}m`;
};
