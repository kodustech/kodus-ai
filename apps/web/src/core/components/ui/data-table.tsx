"use client";

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { useState } from "react";
import {
    Column,
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
    type TableOptions,
} from "@tanstack/react-table";
import {
    ArrowDown,
    ArrowUp,
    ChevronLeft,
    ChevronRight,
    ChevronsUpDown,
    Search,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Spinner } from "./spinner";

const SELECTABLE_COLUMN_ID = "#select";

const LoadingRow = ({ columnsQuantity }: { columnsQuantity: number }) => (
    <TableRow className="hover:bg-transparent">
        <TableCell colSpan={columnsQuantity} align="center">
            <Spinner className="size-7" />
        </TableCell>
    </TableRow>
);

export function DataTable<TData>({
    loading,
    EmptyComponent = "No results found.",
    onRowClick,
    searchable,
    searchPlaceholder = "Search…",
    searchValue,
    onSearchChange,
    pageSize,
    ...tableProps
}: Omit<TableOptions<TData>, "data" | "columns" | "getCoreRowModel"> &
    Required<Pick<TableOptions<TData>, "data" | "columns">> & {
        EmptyComponent?: React.ReactNode;
        loading?: true | "bottom" | false;
        meta?: Record<string, any>;
        /** Optional: makes rows clickable (whole-row), receives the row data. */
        onRowClick?: (row: TData) => void;
        /** Show a global search box that filters across all columns. */
        searchable?: boolean;
        searchPlaceholder?: string;
        /** Enable client-side pagination at this page size. */
        pageSize?: number;
    } & (
        | { searchValue?: undefined; onSearchChange?: undefined }
        | {
              /**
               * Controlled search value. When provided, the caller owns the
               * search state (e.g. to mirror it into the URL) and the
               * matching `onSearchChange` handler is required — the union
               * prevents passing one without the other.
               */
              searchValue: string;
              onSearchChange: (value: string) => void;
          }
    )) {
    const [internalFilter, setInternalFilter] = useState("");
    const controlledSearch = searchValue !== undefined;
    const globalFilter = controlledSearch ? searchValue : internalFilter;
    const setGlobalFilter = (updater: string | ((prev: string) => string)) => {
        const next =
            typeof updater === "function" ? updater(globalFilter) : updater;
        (controlledSearch ? onSearchChange! : setInternalFilter)(next);
    };
    const enablePagination = typeof pageSize === "number";

    const table = useReactTable({
        globalFilterFn: "includesString",
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        columnResizeMode: "onChange",
        enableColumnResizing: false,
        ...(enablePagination && {
            getPaginationRowModel: getPaginationRowModel(),
            initialState: { pagination: { pageSize } },
        }),
        ...(searchable && {
            state: { globalFilter },
            onGlobalFilterChange: setGlobalFilter,
        }),
        ...tableProps,
    });

    const filteredCount = table.getFilteredRowModel().rows.length;

    const tableEl = (
        <Table>
            <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id}>
                        {headerGroup.headers.map((header) => {
                            return (
                                <TableHead
                                    key={header.id}
                                    align={header.column.columnDef.meta?.align}
                                    style={{
                                        maxWidth: header.column.getSize(),
                                    }}>
                                    {header.isPlaceholder
                                        ? null
                                        : flexRender(
                                              header.column.columnDef.header,
                                              header.getContext(),
                                          )}

                                    {header.column.getCanResize() && (
                                        <div
                                            onMouseDown={header.getResizeHandler()}
                                            onTouchStart={header.getResizeHandler()}
                                            className={cn(
                                                "bg-card-lv2 absolute inset-y-0 right-0 w-0.5 cursor-col-resize touch-none select-none",
                                                header.column.getIsResizing() &&
                                                    "bg-card-lv3",
                                            )}
                                        />
                                    )}
                                </TableHead>
                            );
                        })}
                    </TableRow>
                ))}
            </TableHeader>

            <TableBody>
                {loading === true ? (
                    <LoadingRow columnsQuantity={tableProps.columns.length} />
                ) : (
                    <>
                        {!table.getRowModel().rows.length ? (
                            <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={tableProps.columns.length}>
                                    {EmptyComponent}
                                </TableCell>
                            </TableRow>
                        ) : (
                            <>
                                {table.getRowModel().rows.map((row) => (
                                    <TableRow
                                        key={row.id}
                                        onClick={
                                            onRowClick
                                                ? () =>
                                                      onRowClick(row.original)
                                                : undefined
                                        }
                                        className={
                                            onRowClick
                                                ? "hover:bg-card-lv2 cursor-pointer"
                                                : undefined
                                        }
                                        data-peek={
                                            table.options.meta?.peek === row.id
                                                ? ""
                                                : undefined
                                        }
                                        data-selected={
                                            row.getIsSelected() ? "" : undefined
                                        }>
                                        {row.getVisibleCells().map((cell) => (
                                            <TableCell
                                                key={cell.id}
                                                align={
                                                    cell.column.columnDef.meta
                                                        ?.align
                                                }
                                                style={{
                                                    width: cell.column.getSize(),
                                                }}>
                                                {flexRender(
                                                    cell.column.columnDef.cell,
                                                    cell.getContext(),
                                                )}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}

                                {loading === "bottom" && (
                                    <LoadingRow
                                        columnsQuantity={
                                            tableProps.columns.length
                                        }
                                    />
                                )}
                            </>
                        )}
                    </>
                )}
            </TableBody>
        </Table>
    );

    if (!searchable && !enablePagination) return tableEl;

    const pageIndex = table.getState().pagination.pageIndex;
    const pageCount = table.getPageCount();

    return (
        <div className="flex flex-col gap-3">
            {searchable && (
                <div className="bg-card-lv2 border-card-lv3 flex items-center gap-2 rounded-md border px-3 py-2">
                    <Search className="text-text-tertiary size-3.5 shrink-0" />
                    <input
                        type="search"
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        placeholder={searchPlaceholder}
                        className="text-text-secondary placeholder:text-text-tertiary w-full bg-transparent text-xs outline-none"
                    />
                    {globalFilter.trim() && (
                        <span className="text-text-tertiary text-xs whitespace-nowrap">
                            {filteredCount} of {tableProps.data.length}
                        </span>
                    )}
                </div>
            )}

            {tableEl}

            {enablePagination && pageCount > 1 && (
                <div className="text-text-tertiary flex items-center justify-between text-xs">
                    <span>
                        Page {pageIndex + 1} of {pageCount} · {filteredCount}{" "}
                        rows
                    </span>
                    <div className="flex gap-2">
                        <Button
                            size="xs"
                            variant="helper"
                            leftIcon={<ChevronLeft />}
                            disabled={!table.getCanPreviousPage()}
                            onClick={() => table.previousPage()}>
                            Prev
                        </Button>
                        <Button
                            size="xs"
                            variant="helper"
                            rightIcon={<ChevronRight />}
                            disabled={!table.getCanNextPage()}
                            onClick={() => table.nextPage()}>
                            Next
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

export function DataTableColumnHeader<TData, TValue>({
    column,
    title,
    className,
}: React.HTMLAttributes<HTMLDivElement> & {
    title: string;
    column: Column<TData, TValue>;
}) {
    if (!column.getCanSort()) {
        return (
            <div className={cn(className, "text-text-tertiary")}>{title}</div>
        );
    }

    return (
        <div className={cn("flex items-center gap-2", className)}>
            <Button
                size="sm"
                variant="cancel"
                className="px-0"
                onClick={() => column.toggleSorting()}
                rightIcon={
                    column.getIsSorted() === "desc" ? (
                        <ArrowDown />
                    ) : column.getIsSorted() === "asc" ? (
                        <ArrowUp />
                    ) : (
                        <ChevronsUpDown />
                    )
                }>
                {title}
            </Button>
        </div>
    );
}

export const getSelectableColumn = <T,>(): ColumnDef<T> => ({
    id: SELECTABLE_COLUMN_ID,
    enableHiding: false,
    size: 40,
    enableSorting: false,
    enableResizing: false,
    header: ({ table }) => (
        <div
            className="absolute inset-0 flex items-center justify-center"
            onClick={() => table.toggleAllPageRowsSelected()}>
            <Checkbox
                className="size-5"
                onChange={() => table.toggleAllPageRowsSelected()}
                checked={
                    table.getIsAllPageRowsSelected() ||
                    (table.getIsSomePageRowsSelected() && "indeterminate")
                }
            />
        </div>
    ),
    cell: ({ row }) => (
        <div
            onClick={() => row.toggleSelected()}
            className={cn(
                "absolute inset-0 flex items-center justify-center",
                !row.getCanSelect() && "pointer-events-none",
            )}>
            <Checkbox
                className="size-5"
                checked={row.getIsSelected()}
                disabled={!row.getCanSelect()}
                onChange={() => row.toggleSelected()}
            />
        </div>
    ),
});
