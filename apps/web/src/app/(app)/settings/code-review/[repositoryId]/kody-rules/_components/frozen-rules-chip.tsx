"use client";

import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { SnowflakeIcon, X } from "lucide-react";

type FrozenRulesChipProps = {
    count: number;
    isFiltering: boolean;
    onApply: () => void;
    onClear: () => void;
};

// Sits inline with the other filter chips. Click to filter the list down to
// the rules imported from coding-agent files; click the X to clear.
export const FrozenRulesChip = ({
    count,
    isFiltering,
    onApply,
    onClear,
}: FrozenRulesChipProps) => {
    if (count === 0) return null;

    const label =
        count === 1
            ? "1 rule from a coding-agent file"
            : count + " rules from coding-agent files";

    const tooltipBody = (
        <>
            <p>
                {count === 1 ? "This rule was" : "These rules were"} imported
                from CLAUDE.md, AGENTS.md, .cursor/rules or Copilot
                instructions. Those files are no longer turned into rules, so{" "}
                {count === 1 ? "it no longer updates" : "they no longer update"}
                .
            </p>
            <p>
                Keep a convention by moving it to a .kody/rules file, or pause
                or delete it here. Kody can read the coding-agent files
                themselves during review: turn on Coding-agent instructions in
                What to review.
            </p>
            <p>
                {isFiltering
                    ? "Click the × to clear the filter."
                    : "Click to show only these rules."}
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
                            if (isFiltering) onClear();
                            else onApply();
                        }
                    }}
                    className={
                        isFiltering
                            ? "bg-warning/25 text-warning ring-warning hover:bg-warning/30 focus-visible:ring-warning inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold uppercase ring-1 transition-colors focus:outline-none focus-visible:ring-2"
                            : "bg-warning/10 text-warning ring-warning/40 hover:bg-warning/20 focus-visible:ring-warning inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11px] uppercase ring-1 transition-colors focus:outline-none focus-visible:ring-2"
                    }>
                    <SnowflakeIcon className="size-3" aria-hidden />
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
