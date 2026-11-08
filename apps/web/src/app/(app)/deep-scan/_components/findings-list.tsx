"use client";

import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import type { IssueListItem, IssueStatus } from "@services/issues/types";
import { formatDistanceToNow } from "date-fns";
import { useQueryState } from "nuqs";
import { SeverityLevel } from "src/core/types";
import { cn } from "src/core/utils/components";

import { StatusBadge } from "../../issues/_components/status-badge";

const SEVERITY_RANK: Record<SeverityLevel, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

export type FindingsStatusFilter = IssueStatus | "all";

const STATUS_TABS: { value: FindingsStatusFilter; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "resolved", label: "Resolved" },
    { value: "dismissed", label: "Dismissed" },
    { value: "all", label: "All" },
];

/**
 * What the scans found, worst first. A row is one vulnerability: its title on
 * one line, then where it is (file, CWE) and who owns it, so the list reads
 * without opening every finding. A click opens the issue beside the list.
 */
export const FindingsList = ({
    findings,
    loading,
    status,
    onStatusChange,
    severity,
}: {
    findings: IssueListItem[];
    loading: boolean;
    status: FindingsStatusFilter;
    onStatusChange: (status: FindingsStatusFilter) => void;
    severity: SeverityLevel | null;
}) => {
    const [peek, setPeek] = useQueryState("peek");

    const shown = findings
        .filter((f) => status === "all" || f.status === status)
        .filter((f) => !severity || f.severity === severity)
        .sort(
            (a, b) =>
                (SEVERITY_RANK[a.severity] ?? 9) -
                    (SEVERITY_RANK[b.severity] ?? 9) ||
                new Date(b.createdAt).getTime() -
                    new Date(a.createdAt).getTime(),
        );

    const countOf = (value: FindingsStatusFilter) =>
        value === "all"
            ? findings.length
            : findings.filter((f) => f.status === value).length;

    return (
        <section className="flex min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">Findings</h2>

                <div
                    role="tablist"
                    className="bg-card-lv1 border-card-lv3/60 flex rounded-lg border p-0.5 text-xs">
                    {STATUS_TABS.map((tab) => (
                        <button
                            key={tab.value}
                            type="button"
                            role="tab"
                            aria-selected={status === tab.value}
                            onClick={() => onStatusChange(tab.value)}
                            className={cn(
                                "text-text-secondary rounded-md px-3 py-1.5 transition-colors",
                                status === tab.value &&
                                    "bg-card-lv3 text-text-primary",
                            )}>
                            {tab.label}
                            <span className="text-text-tertiary ml-1.5 tabular-nums">
                                {countOf(tab.value)}
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="border-card-lv3/60 bg-card-lv1 min-h-0 overflow-y-auto rounded-xl border">
                {loading ? (
                    <p className="text-text-secondary px-4 py-6 text-sm">
                        Loading findings…
                    </p>
                ) : shown.length === 0 ? (
                    <p className="text-text-secondary px-4 py-6 text-sm">
                        {findings.length === 0
                            ? "Nothing found yet. A scan's findings show up here as it stores them."
                            : "No finding matches this filter."}
                    </p>
                ) : (
                    <ul className="divide-card-lv3/60 divide-y">
                        {shown.map((finding) => (
                            <FindingRow
                                key={finding.uuid}
                                finding={finding}
                                active={peek === finding.uuid}
                                onOpen={() =>
                                    setPeek(
                                        peek === finding.uuid
                                            ? null
                                            : finding.uuid,
                                    )
                                }
                            />
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
};

const FindingRow = ({
    finding,
    active,
    onOpen,
}: {
    finding: IssueListItem;
    active: boolean;
    onOpen: () => void;
}) => {
    const where = [finding.filePath, finding.cwe].filter(Boolean).join(" · ");
    const owner = finding.owner?.username;

    return (
        <li data-peek={active ? "" : undefined}>
            <button
                type="button"
                onClick={onOpen}
                className={cn(
                    "hover:bg-card-lv2 grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3 text-left transition-colors md:grid-cols-[auto_minmax(0,1fr)_10rem_6rem_6rem]",
                    active && "bg-card-lv2",
                )}>
                <IssueSeverityLevelBadge severity={finding.severity} />

                <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-text-primary truncate text-sm font-medium">
                        {finding.title}
                    </span>
                    <span className="text-text-tertiary truncate font-mono text-xs">
                        {finding.repository.name} · {where}
                    </span>
                </span>

                <span className="text-text-secondary hidden truncate text-xs md:block">
                    {owner ? (
                        <>
                            {owner}
                            {finding.owner?.origin === "codeowners" && (
                                <span className="text-text-tertiary">
                                    {" "}
                                    · CODEOWNERS
                                </span>
                            )}
                        </>
                    ) : (
                        <span className="text-text-tertiary">No owner</span>
                    )}
                </span>

                <span className="hidden md:block">
                    <StatusBadge value={finding.status} />
                </span>

                <span className="text-text-tertiary text-right text-xs whitespace-nowrap">
                    {formatDistanceToNow(new Date(finding.createdAt), {
                        addSuffix: true,
                    })}
                </span>
            </button>
        </li>
    );
};
