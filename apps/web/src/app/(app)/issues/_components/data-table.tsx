"use client";

import { useRef } from "react";
import { Skeleton } from "@components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import type { IssueListItem } from "@services/issues/types";
import {
    flexRender,
    getCoreRowModel,
    useReactTable,
    type TableOptions,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

import { columns } from "../_constants/columns";

export const IssuesDataTable = (
    props: Omit<
        TableOptions<IssueListItem>,
        "columns" | "getCoreRowModel" | "getRowId"
    > & {
        peek: string | null;
        loading?: boolean;
    },
) => {
    const table = useReactTable({
        data: props.data,
        columns: columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (r) => r.uuid,
    });

    const { rows } = table.getRowModel();

    const parentRef = useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 56,
    });

    return (
        <div
            ref={parentRef}
            // 'transition-none' is required for table virtualization to avoid stuttering
            className="flex-1 overflow-auto **:transition-none">
            <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
                {/* '--table-body-height' is required for sticky header to work */}
                <Table className="after:inline-block after:h-(--table-body-height)">
                    <TableHeader sticky>
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead
                                            key={header.id}
                                            align={
                                                header.column.columnDef.meta
                                                    ?.align
                                            }
                                            style={{
                                                maxWidth:
                                                    header.column.getSize(),
                                            }}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                      header.column.columnDef
                                                          .header,
                                                      header.getContext(),
                                                  )}
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>

                    <TableBody
                        ref={(ref) => {
                            if (!ref) return;

                            const height =
                                virtualizer.getTotalSize() -
                                ref.getBoundingClientRect().height;

                            // '--table-body-height' is required for sticky header to work
                            document.documentElement.style.setProperty(
                                "--table-body-height",
                                `${height}px`,
                            );
                        }}>
                        {props.loading === true ? (
                            Array.from({ length: 8 }).map((_, i) => (
                                <TableRow
                                    key={`skeleton-${i}`}
                                    className="hover:bg-transparent">
                                    <TableCell colSpan={columns.length}>
                                        <div
                                            className="flex items-center gap-4"
                                            aria-hidden>
                                            <Skeleton className="h-4 w-2/5" />
                                            <Skeleton className="ml-auto h-5 w-20 rounded-md" />
                                            <Skeleton className="h-5 w-16 rounded-md" />
                                            <Skeleton className="h-4 w-24" />
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        ) : (
                            <>
                                {!rows.length ? (
                                    <TableRow className="hover:bg-transparent">
                                        <TableCell colSpan={columns.length}>
                                            No results found.
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    <>
                                        {virtualizer
                                            .getVirtualItems()
                                            .map((virtualRow, index) => {
                                                const row =
                                                    rows[virtualRow.index];
                                                return (
                                                    <TableRow
                                                        key={row.id}
                                                        data-peek={
                                                            props.peek ===
                                                            row.id
                                                                ? ""
                                                                : undefined
                                                        }
                                                        style={{
                                                            height: `${virtualRow.size}px`,
                                                            transform: `translateY(${virtualRow.start - index * virtualRow.size}px)`,
                                                        }}>
                                                        {row
                                                            .getVisibleCells()
                                                            .map((cell) => (
                                                                <TableCell
                                                                    key={
                                                                        cell.id
                                                                    }
                                                                    align={
                                                                        cell
                                                                            .column
                                                                            .columnDef
                                                                            .meta
                                                                            ?.align
                                                                    }
                                                                    style={{
                                                                        width: cell.column.getSize(),
                                                                    }}>
                                                                    {flexRender(
                                                                        cell
                                                                            .column
                                                                            .columnDef
                                                                            .cell,
                                                                        cell.getContext(),
                                                                    )}
                                                                </TableCell>
                                                            ))}
                                                    </TableRow>
                                                );
                                            })}
                                    </>
                                )}
                            </>
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
};
