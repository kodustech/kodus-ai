"use client";

import { DataTableColumnHeader } from "@components/ui/data-table";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
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

/**
 * Derives the rule's scope label from its repo/folder fields. For folder
 * scope, a directory can group several folders — surface the first as the
 * primary detail, the count of the rest as `extra`, and the full list as
 * `title` (tooltip), mirroring the code-review sidebar.
 */
function ruleScope(row: KodyRuleHealthRow): {
    kind: "Global" | "Repo" | "Folder";
    detail: string | null;
    extra: number;
    items: string[];
} {
    if (row.directoryId) {
        const folders = row.directoryFolders ?? [];
        const detail = folders[0] ?? row.directoryId;
        return {
            kind: "Folder",
            detail,
            extra: folders.length > 1 ? folders.length - 1 : 0,
            items: folders.length ? folders : [detail],
        };
    }
    if (row.repositoryId) {
        const detail = row.repositoryName ?? row.repositoryId;
        return { kind: "Repo", detail, extra: 0, items: [detail] };
    }
    return { kind: "Global", detail: null, extra: 0, items: [] };
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
            const { kind, detail, extra, items } = ruleScope(row.original);
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
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="text-text-tertiary flex min-w-0 cursor-default items-center gap-1 font-mono">
                                    <span className="max-w-[180px] truncate">
                                        {detail}
                                    </span>
                                    {extra > 0 && (
                                        <span className="text-text-tertiary/70 shrink-0">
                                            +{extra}
                                        </span>
                                    )}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="text-xs">
                                <ul className="list-none space-y-0.5">
                                    {items.map((p) => (
                                        <li key={p} className="font-mono">
                                            {p}
                                        </li>
                                    ))}
                                </ul>
                            </TooltipContent>
                        </Tooltip>
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
