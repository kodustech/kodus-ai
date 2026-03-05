"use client";

import { Spinner } from "@components/ui/spinner";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";

import { PrListItem } from "./pr-list-item";
import type { PullRequestExecutionGroup } from "./types";

interface PrDataTableProps {
    data: PullRequestExecutionGroup[];
    loading?: boolean;
}

export const PrDataTable = ({ data, loading }: PrDataTableProps) => {
    if (loading) {
        return (
            <div className="flex items-center justify-center py-12">
                <Spinner className="size-7" />
            </div>
        );
    }

    if (!data.length) {
        return (
            <div className="py-12 text-center">
                <p className="text-text-secondary text-sm">
                    No pull requests found.
                </p>
            </div>
        );
    }

    return (
        <TableContainer className="border-card-lv3/40 bg-card-lv1/50 rounded-xl border">
            <Table className="w-full">
                <TableHeader>
                    <TableRow className="hover:bg-transparent">
                        <TableHead className="w-8"></TableHead>
                        <TableHead className="text-text-tertiary w-20 text-xs font-medium tracking-wide uppercase">
                            PR
                        </TableHead>
                        <TableHead className="text-text-tertiary min-w-[18rem] text-xs font-medium tracking-wide uppercase">
                            Title
                        </TableHead>
                        <TableHead className="text-text-tertiary w-32 text-xs font-medium tracking-wide uppercase">
                            Repository
                        </TableHead>
                        <TableHead className="text-text-tertiary w-40 text-xs font-medium tracking-wide uppercase">
                            Branch
                        </TableHead>
                        <TableHead className="text-text-tertiary w-40 text-xs font-medium tracking-wide uppercase">
                            Author
                        </TableHead>
                        <TableHead className="text-text-tertiary w-20 text-center text-xs font-medium tracking-wide uppercase">
                            Reviews
                        </TableHead>
                        <TableHead className="text-text-tertiary w-32 text-xs font-medium tracking-wide uppercase">
                            Created
                        </TableHead>
                        <TableHead className="text-text-tertiary w-20 text-center text-xs font-medium tracking-wide uppercase">
                            Suggestions
                        </TableHead>
                        <TableHead className="text-text-tertiary w-32 text-center text-xs font-medium tracking-wide uppercase">
                            Status
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {data.map((group) => (
                        <PrListItem key={group.prId} group={group} />
                    ))}
                </TableBody>
            </Table>
        </TableContainer>
    );
};
