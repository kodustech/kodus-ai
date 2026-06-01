"use client";

import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { AlertTriangle, X } from "lucide-react";

type OrphanRulesChipProps = {
    count: number;
    isFiltering: boolean;
    onApply: () => void;
    onClear: () => void;
};

// Lightweight replacement for the old yellow banner. Sits inline with the
// other filter chips so the warning is visible but doesn't dominate the
// page. Click to filter the list down to the orphan auto-sync rules; click
// the X (when filtering) to clear.
export const OrphanRulesChip = ({
    count,
    isFiltering,
    onApply,
    onClear,
}: OrphanRulesChipProps) => {
    if (count === 0) return null;

    const label =
        count === 1
            ? "1 orphan auto-sync rule"
            : count + " orphan auto-sync rules";

    const tooltipBody = (
        <>
            <p>
                Auto-sync is off for this repository, but {count}{" "}
                {count === 1 ? "rule was" : "rules were"} imported by it and
                {count === 1 ? " hasn't" : " haven't"} been cleaned up yet
                (active or paused).
            </p>
            <p>
                {isFiltering
                    ? "Click the × to clear the filter."
                    : "Click to filter the list to just these so you can review and clean them up."}
            </p>
        </>
    );

    return (
        <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
                <span
                    role="button"
                    tabIndex={0}
                    aria-pressed={isFiltering}
                    aria-label={
                        isFiltering
                            ? "Showing only " + label + ". Click to clear."
                            : "Filter list to " + label
                    }
                    onClick={isFiltering ? onClear : onApply}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            isFiltering ? onClear() : onApply();
                        }
                    }}
                    className={
                        isFiltering
                            ? "bg-warning/25 text-warning ring-warning inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold uppercase ring-1 transition-colors hover:bg-warning/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-warning"
                            : "bg-warning/10 text-warning ring-warning/40 hover:bg-warning/20 focus-visible:ring-warning inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11px] uppercase ring-1 transition-colors focus:outline-none focus-visible:ring-2"
                    }>
                    <AlertTriangle className="size-3" aria-hidden />
                    {label}
                    {isFiltering && (
                        <X className="size-3 opacity-80" aria-hidden />
                    )}
                </span>
            </TooltipTrigger>
            <TooltipContent>{tooltipBody}</TooltipContent>
        </Tooltip>
    );
};
