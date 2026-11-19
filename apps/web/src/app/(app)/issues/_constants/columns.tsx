"use client";

import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { DataTableColumnHeader } from "@components/ui/data-table";
import { Markdown } from "@components/ui/markdown";
import type { IssueListItem } from "@services/issues/types";
import { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { useQueryState } from "nuqs";
import { cn } from "src/core/utils/components";

import { SecurityScanBadge } from "../_components/security-scan/security-scan-badge";
import { StatusBadge } from "../_components/status-badge";

type Row = IssueListItem;

const TableLink = ({
    id,
    children,
    className,
    ...props
}: React.PropsWithChildren & { id: string; className?: string }) => {
    const [peek, setPeek] = useQueryState("peek");

    return (
        <div
            {...props}
            onClick={() => setPeek(peek === id ? null : id)}
            className={cn(
                "absolute inset-0 flex cursor-pointer items-center px-[inherit] text-left align-middle select-none",
                className,
            )}>
            {children}
        </div>
    );
};

export const columns: ColumnDef<Row>[] = [
    // getSelectableColumn<Row>(),
    {
        id: "status",
        accessorFn: (item) => item.status,
        meta: {
            name: "Status",
            filters: { "is": true, "is-not": true },
        },
        size: 70,
        minSize: 70,
        enableSorting: false,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid}>
                <StatusBadge value={getValue<Row["status"]>()} />
            </TableLink>
        ),
    },
    {
        id: "severity",
        accessorFn: (item) => item.severity,
        enableSorting: false,
        meta: { name: "Severity", filters: { "is": true, "is-not": true } },
        size: 80,
        minSize: 80,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Severity" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid}>
                <IssueSeverityLevelBadge
                    severity={getValue<Row["severity"]>()}
                />
            </TableLink>
        ),
    },
    {
        id: "label",
        accessorFn: (item) => item.label,
        enableSorting: false,
        meta: { name: "Category", filters: { "is": true, "is-not": true } },
        size: 120,
        minSize: 120,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Category" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid}>
                {getValue<string>().replaceAll("_", " ")}
            </TableLink>
        ),
    },
    {
        id: "title",
        accessorFn: (item) => item.title,
        meta: {
            name: "Title",
            filters: { "contains": true, "does-not-contain": true },
        },
        enableSorting: false,
        minSize: 450,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Title" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid} className="gap-2">
                {row.original.source === "security_scan" && (
                    <SecurityScanBadge />
                )}
                <Markdown>{getValue<string>()}</Markdown>
            </TableLink>
        ),
    },
    {
        id: "repository.name",
        accessorFn: (item) => item.repository.name,
        enableSorting: false,
        meta: { name: "Repository", filters: { "is": true, "is-not": true } },
        minSize: 150,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Repository" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid}>{getValue<string>()}</TableLink>
        ),
    },
    {
        id: "filePath",
        accessorFn: (item) => item.filePath,
        meta: {
            name: "File path",
            filters: { "contains": true, "does-not-contain": true },
        },
        enableSorting: false,
        minSize: 250,
        maxSize: 350,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="File" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid}>
                <span className="line-clamp-1 text-ellipsis [direction:rtl]">
                    {getValue<string>()}
                </span>
            </TableLink>
        ),
    },
    {
        id: "age",
        size: 100,
        minSize: 100,
        meta: { name: "Age" },
        enableSorting: false,
        accessorFn: (item) => item.createdAt,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Age" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid}>
                {formatDistanceToNow(getValue<string>())}
            </TableLink>
        ),
    },
    {
        id: "prNumbers",
        size: 60,
        minSize: 60,
        meta: {
            name: "PR numbers",
            filters: {
                "contains": true,
                "does-not-contain": true,
            },
        },
        enableSorting: false,
        accessorFn: (item) => item.prNumbers,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="#PR(s)" />
        ),
        cell: ({ getValue, row }) => (
            <TableLink id={row.original.uuid}>
                {getValue<string[]>().join(", ")}
            </TableLink>
        ),
    },
];
