"use client";

import type { CSSProperties } from "react";
import { severityColorVar } from "@components/system/issue-severity-level-badge";
import type { IssueListItem } from "@services/issues/types";
import { SeverityLevel } from "src/core/types";
import { cn } from "src/core/utils/components";

const ORDER = [
    SeverityLevel.CRITICAL,
    SeverityLevel.HIGH,
    SeverityLevel.MEDIUM,
    SeverityLevel.LOW,
];

const LABEL: Record<SeverityLevel, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
};

/**
 * Open findings per severity, the first thing to read after the status:
 * each tile filters the list below to its tier, and a second click clears it.
 */
export const SeveritySummary = ({
    findings,
    selected,
    onSelect,
}: {
    findings: IssueListItem[];
    selected: SeverityLevel | null;
    onSelect: (severity: SeverityLevel | null) => void;
}) => {
    const open = findings.filter((f) => f.status === "open");

    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {ORDER.map((severity) => {
                const count = open.filter(
                    (f) => f.severity === severity,
                ).length;
                const active = selected === severity;
                return (
                    <button
                        key={severity}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onSelect(active ? null : severity)}
                        style={
                            {
                                "--tier": severityColorVar[severity],
                            } as CSSProperties
                        }
                        className={cn(
                            "bg-card-lv1 border-card-lv3/60 hover:border-card-lv3 flex flex-col gap-1 rounded-xl border px-4 py-3 text-left transition-colors",
                            active && "border-(--tier) hover:border-(--tier)",
                        )}>
                        <span className="text-text-secondary flex items-center gap-2 text-xs">
                            <span
                                className="size-2 rounded-full bg-(--tier)"
                                aria-hidden
                            />
                            {LABEL[severity]}
                        </span>
                        <span
                            className={cn(
                                "text-2xl font-semibold tabular-nums",
                                count === 0
                                    ? "text-text-tertiary"
                                    : "text-text-primary",
                            )}>
                            {count}
                        </span>
                        <span className="text-text-tertiary text-xs">open</span>
                    </button>
                );
            })}
        </div>
    );
};
