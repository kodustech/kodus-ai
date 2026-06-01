"use client";

import { Button } from "@components/ui/button";
import type { ListFilters } from "src/core/utils/kody-rules/apply-filters";

const SEVERITY_LEVELS = [
    { value: "critical", label: "Critical" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
] as const;

const SEVERITY_COLOR: Record<string, string> = {
    critical:
        "bg-danger/10 text-danger ring-danger/40 hover:bg-danger/20 data-[active=true]:bg-danger/30",
    high: "bg-warning/10 text-warning ring-warning/40 hover:bg-warning/20 data-[active=true]:bg-warning/30",
    medium: "bg-alert/10 text-alert ring-alert/40 hover:bg-alert/20 data-[active=true]:bg-alert/30",
    low: "bg-info/10 text-info ring-info/40 hover:bg-info/20 data-[active=true]:bg-info/30",
};

type SeverityHeatmapProps = {
    counts: Record<string, number>;
    filters: ListFilters;
    onFiltersChange: (next: ListFilters) => void;
};

// Clickable severity counters at the top of the rules list. Tapping one
// toggles that severity in the active filters. Lets users see the
// distribution at a glance and drill in with one click.
//
// Severities with zero rules are hidden — clicking a "0 Medium" chip
// would just empty the list, so it's noise. The exception is severities
// that the user explicitly has selected in the filters: those stay
// visible (greyed-out style via the active state) so the user can
// un-toggle without having to open the Filters popover.
export const SeverityHeatmap = ({
    counts,
    filters,
    onFiltersChange,
}: SeverityHeatmapProps) => {
    const visibleLevels = SEVERITY_LEVELS.filter(({ value }) => {
        const count = counts[value] ?? 0;
        return count > 0 || filters.severities.has(value);
    });

    if (visibleLevels.length === 0) return null;

    const toggle = (value: string) => {
        const next = new Set(filters.severities);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        onFiltersChange({ ...filters, severities: next });
    };

    return (
        <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Filter by severity">
            {visibleLevels.map(({ value, label }) => {
                const count = counts[value] ?? 0;
                const active = filters.severities.has(value);
                return (
                    <button
                        key={value}
                        type="button"
                        onClick={() => toggle(value)}
                        data-active={active ? "true" : "false"}
                        aria-pressed={active}
                        className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium ring-1 transition-colors focus:outline-none focus-visible:ring-2 ${SEVERITY_COLOR[value]}`}>
                        <span className="font-semibold tabular-nums">
                            {count}
                        </span>
                        <span>{label}</span>
                    </button>
                );
            })}
        </div>
    );
};
