import * as React from "react";
import { cn } from "src/core/utils/components";

const TableContainer = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>((props, ref) => (
    <div
        ref={ref}
        {...props}
        className={cn("relative w-full overflow-x-auto", props.className)}
    />
));
TableContainer.displayName = "TableContainer";

const Table = React.forwardRef<
    HTMLTableElement,
    React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
    <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
    />
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
    HTMLTableSectionElement,
    React.HTMLAttributes<HTMLTableSectionElement> & {
        sticky?: boolean;
    }
>(({ className, sticky, ...props }, ref) => (
    <thead
        ref={ref}
        className={cn("", sticky && "sticky top-0 z-1", className)}
        {...props}
    />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
    HTMLTableSectionElement,
    React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
    <tbody
        ref={ref}
        className={cn("[&_tr:last-child]:border-0", className)}
        {...props}
    />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
    HTMLTableSectionElement,
    React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
    <tfoot
        ref={ref}
        className={cn(
            "bg-card-lv1 border-card-lv1 border-t font-semibold last:[&>tr]:border-b-0",
            className,
        )}
        {...props}
    />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<
    HTMLTableRowElement,
    React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
    <tr
        ref={ref}
        className={cn(
            "relative transition",
            "hover:bg-card-lv1/50",

            "data-peek:bg-card-lv2",
            "data-peek:hover:bg-card-lv2/75",
            className,
        )}
        {...props}
    />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
    HTMLTableCellElement,
    React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, align = "left", ...props }, ref) => (
    <th
        ref={ref}
        className={cn(
            "bg-card-lv1 relative h-14 px-5 align-middle font-semibold [&:has([role=checkbox])]:px-0",
            className,
        )}
        {...props}
        align={align}
    />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
    HTMLTableCellElement,
    React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
    <td
        ref={ref}
        align="left"
        className={cn(
            "border-card-lv1 relative h-14 border-b px-5 py-3 align-middle [&:has([role=checkbox])]:px-0",
            className,
        )}
        {...props}
    />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
    HTMLTableCaptionElement,
    React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
    <caption ref={ref} className={cn("mt-4 text-sm", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

export {
    Table,
    TableBody,
    TableCaption,
    TableCell,
    TableContainer,
    TableFooter,
    TableHead,
    TableHeader,
    TableRow,
};
