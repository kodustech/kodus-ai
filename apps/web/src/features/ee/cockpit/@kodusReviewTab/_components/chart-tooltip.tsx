"use client";

import type { TooltipContentProps } from "recharts";

/**
 * shadcn-style floating tooltip: dark card, dashed-grid friendly, a
 * colored swatch per series. `unit` and an optional value formatter keep
 * it reusable across the review charts.
 */
export const ChartTooltip = ({
    active,
    payload,
    label,
    unit = "",
    labelFormatter,
    valueFormatter,
}: TooltipContentProps<number, string> & {
    unit?: string;
    labelFormatter?: (label: string) => string;
    valueFormatter?: (value: number, name: string) => string;
}) => {
    if (!active || !payload?.length) return null;

    return (
        <div className="bg-card-lv1 border-card-lv3 min-w-36 rounded-lg border px-3 py-2 shadow-xl">
            <div className="text-text-primary mb-1.5 text-xs font-semibold">
                {labelFormatter ? labelFormatter(String(label)) : label}
            </div>
            {payload.map((entry, i) => (
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
                            : `${entry.value}${unit}`}
                    </span>
                </div>
            ))}
        </div>
    );
};
