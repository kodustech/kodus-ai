"use client";

import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Badge } from "@components/ui/badge";
import { DataTableColumnHeader } from "@components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";

import type { SuggestionsExplorerItem } from "../../_services/analytics/review/explorer-fetch";

const statusLabel = (status: string | null) => {
    if (status === "implemented") return "✓ Implemented";
    if (status === "partially_implemented") return "◐ Partial";
    return "○ Not implemented";
};

const statusClass = (status: string | null) =>
    status === "implemented" || status === "partially_implemented"
        ? "text-success"
        : "text-text-tertiary";

export const columns: ColumnDef<SuggestionsExplorerItem>[] = [
    {
        accessorKey: "severity",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Severity" />
        ),
        cell: ({ row }) =>
            row.original.severity ? (
                <IssueSeverityLevelBadge severity={row.original.severity} />
            ) : (
                <span className="text-text-tertiary">—</span>
            ),
        size: 110,
    },
    {
        accessorKey: "summary",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Suggestion" />
        ),
        cell: ({ row }) => (
            <span className="line-clamp-2 max-w-[420px] text-sm">
                {row.original.summary ?? "(no summary)"}
            </span>
        ),
        size: 420,
    },
    {
        accessorKey: "category",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Category" />
        ),
        cell: ({ row }) =>
            row.original.category ? (
                <Badge className="bg-card-lv3 text-text-secondary pointer-events-none rounded-lg px-2 text-[11px]">
                    {row.original.category}
                </Badge>
            ) : null,
        size: 150,
    },
    {
        accessorKey: "implementationStatus",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
            <span
                className={`text-xs font-semibold whitespace-nowrap ${statusClass(
                    row.original.implementationStatus,
                )}`}>
                {statusLabel(row.original.implementationStatus)}
            </span>
        ),
        size: 150,
    },
    {
        id: "file",
        accessorFn: (r) => r.filePath,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="File" />
        ),
        cell: ({ row }) => (
            <span
                title={row.original.filePath ?? undefined}
                className="text-text-tertiary block max-w-[260px] truncate font-mono text-[11px]">
                {row.original.filePath ?? "—"}
            </span>
        ),
        size: 260,
    },
    {
        id: "pr",
        header: "PR",
        cell: ({ row }) =>
            row.original.prNumber ? (
                <span className="text-text-secondary font-mono text-xs whitespace-nowrap">
                    #{row.original.prNumber}
                </span>
            ) : null,
        size: 70,
    },
];
