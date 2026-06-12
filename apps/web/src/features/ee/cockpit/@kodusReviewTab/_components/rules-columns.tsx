"use client";

import { DataTableColumnHeader } from "@components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "src/core/utils/components";

import type {
    KodyRuleHealthRow,
    KodyRuleHealthState,
} from "../../_services/analytics/review/fetch";
import { ImplRateBar } from "./impl-rate-bar";

export const stateMeta: Record<
    KodyRuleHealthState,
    { label: string; className: string }
> = {
    healthy: { label: "Healthy", className: "bg-success/15 text-success" },
    noisy: { label: "Noisy", className: "bg-danger/15 text-danger" },
    ignored: { label: "Ignored", className: "bg-warning/15 text-warning" },
    stale: { label: "Stale", className: "bg-card-lv3 text-text-tertiary" },
    low_data: { label: "Low data", className: "bg-info/15 text-info" },
};

/** Derives the rule's scope label from its repo/folder fields. */
function ruleScope(row: KodyRuleHealthRow): {
    kind: "Global" | "Repo" | "Folder";
    detail: string | null;
} {
    if (row.directoryPath) {
        return { kind: "Folder", detail: row.directoryPath };
    }
    if (row.repositoryId) {
        return { kind: "Repo", detail: row.repositoryName ?? row.repositoryId };
    }
    return { kind: "Global", detail: null };
}

const scopeClass: Record<ReturnType<typeof ruleScope>["kind"], string> = {
    Global: "bg-card-lv3 text-text-secondary",
    Repo: "bg-info/15 text-info",
    Folder: "bg-warning/15 text-warning",
};

export const rulesColumns: ColumnDef<KodyRuleHealthRow>[] = [
    {
        accessorKey: "title",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Rule" />
        ),
        cell: ({ row }) => (
            <span className="text-text-primary max-w-md truncate text-xs font-medium">
                {row.original.title}
            </span>
        ),
    },
    {
        id: "scope",
        accessorFn: (r) => ruleScope(r).kind,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Scope" />
        ),
        cell: ({ row }) => {
            const { kind, detail } = ruleScope(row.original);
            return (
                <span className="flex items-center gap-1.5 text-xs whitespace-nowrap">
                    <span
                        className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-bold",
                            scopeClass[kind],
                        )}>
                        {kind}
                    </span>
                    {detail && (
                        <span
                            className="text-text-tertiary max-w-[180px] truncate font-mono"
                            title={detail}>
                            {detail}
                        </span>
                    )}
                </span>
            );
        },
    },
    {
        accessorKey: "triggers",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Triggers" />
        ),
        cell: ({ row }) => (
            <span className="font-mono text-xs">{row.original.triggers}</span>
        ),
    },
    {
        accessorKey: "rate",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Impl. rate" />
        ),
        cell: ({ row }) => <ImplRateBar rate={row.original.rate} />,
    },
    {
        id: "feedback",
        accessorFn: (r) => r.thumbsDown,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="👍 / 👎" />
        ),
        cell: ({ row }) => (
            <span className="text-xs whitespace-nowrap">
                <span className="text-success">▲ {row.original.thumbsUp}</span>{" "}
                <span className="text-danger">▼ {row.original.thumbsDown}</span>
            </span>
        ),
    },
    {
        accessorKey: "state",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
            <span
                className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-bold whitespace-nowrap",
                    stateMeta[row.original.state].className,
                )}>
                {stateMeta[row.original.state].label}
            </span>
        ),
    },
];
