"use client";

import { DataTableColumnHeader } from "@components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";

import type { RepositoryHealthRow } from "../../_services/analytics/review/fetch";
import { ImplRateBar } from "./impl-rate-bar";

export const repositoriesColumns: ColumnDef<RepositoryHealthRow>[] = [
    {
        accessorKey: "repository",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Repository" />
        ),
        cell: ({ row }) => (
            <span className="text-text-primary font-mono text-xs">
                {row.original.repository}
            </span>
        ),
    },
    {
        accessorKey: "prsReviewed",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="PRs reviewed" />
        ),
        cell: ({ row }) => (
            <span className="font-mono text-xs">
                {row.original.prsReviewed}
            </span>
        ),
    },
    {
        accessorKey: "suggestionsSent",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Suggestions" />
        ),
        cell: ({ row }) => (
            <span className="font-mono text-xs">
                {row.original.suggestionsSent}
            </span>
        ),
    },
    {
        accessorKey: "implementationRate",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Impl. rate" />
        ),
        cell: ({ row }) => (
            <ImplRateBar rate={row.original.implementationRate} />
        ),
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
        id: "weakestCategory",
        accessorFn: (r) => r.weakestCategory?.rate ?? 1,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Weakest category" />
        ),
        cell: ({ row }) => {
            const w = row.original.weakestCategory;
            return (
                <span className="text-text-secondary text-xs">
                    {w
                        ? `${w.category} (${Math.round(w.rate * 100)}%)`
                        : "—"}
                </span>
            );
        },
    },
];
