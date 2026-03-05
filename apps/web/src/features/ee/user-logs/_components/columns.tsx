"use client";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { DataTableColumnHeader } from "@components/ui/data-table";
import type { UserLog } from "@services/userLogs/types";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";
import { EyeIcon } from "lucide-react";

import { LogDetailsModal } from "./log-details-modal";

export const columns: ColumnDef<UserLog>[] = [
    {
        accessorKey: "_action",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Action" />
        ),
        cell: ({ row }) => {
            const action = row.getValue("_action") as string;
            // Map actions to severity colors using the project's design system
            const getActionColor = (action: string) => {
                switch (action) {
                    case "add":
                    case "create":
                        return "bg-success/10 text-success ring-success/64 [--button-foreground:var(--color-success)]";
                    case "edit":
                        return "bg-info/10 text-info ring-info/64 [--button-foreground:var(--color-info)]";
                    case "delete":
                        return "bg-danger/10 text-danger ring-danger/64 [--button-foreground:var(--color-danger)]";
                    case "clone":
                        return "bg-warning/10 text-warning ring-warning/64 [--button-foreground:var(--color-warning)]";
                    default:
                        return "bg-alert/10 text-alert ring-alert/64 [--button-foreground:var(--color-alert)]";
                }
            };

            return (
                <Badge
                    className={`h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 ${getActionColor(action)}`}>
                    {action}
                </Badge>
            );
        },
        enableSorting: true,
        enableHiding: false,
    },
    {
        accessorKey: "_userInfo",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="User" />
        ),
        cell: ({ row }) => {
            const userInfo = row.getValue("_userInfo") as UserLog["_userInfo"];

            return <div className="font-medium">{userInfo.userEmail}</div>;
        },
        enableSorting: true,
        enableHiding: false,
    },
    {
        accessorKey: "_changedData",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Description" />
        ),
        cell: ({ row }) => {
            const changedData = row.getValue(
                "_changedData",
            ) as UserLog["_changedData"];
            const firstChange = changedData[0];

            return (
                <div className="max-w-md truncate">
                    {firstChange?.description || "No description"}
                </div>
            );
        },
        enableSorting: false,
        enableHiding: false,
    },
    {
        accessorKey: "_changedData",
        id: "actionDescription",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Action Description" />
        ),
        cell: ({ row }) => {
            const changedData = row.getValue(
                "_changedData",
            ) as UserLog["_changedData"];
            const firstChange = changedData[0];

            return (
                <div className="max-w-md truncate">
                    {firstChange?.actionDescription || "No action description"}
                </div>
            );
        },
        enableSorting: false,
        enableHiding: false,
    },
    {
        accessorKey: "_configLevel",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Level" />
        ),
        cell: ({ row }) => {
            const level = row.getValue("_configLevel") as string;
            return (
                <Badge variant="helper" className="capitalize">
                    {level}
                </Badge>
            );
        },
        enableSorting: true,
        enableHiding: false,
    },
    {
        accessorKey: "_createdAt",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Date" />
        ),
        cell: ({ row }) => {
            const date = row.getValue("_createdAt") as string;
            return (
                <div className="text-muted-foreground text-sm">
                    {formatDistanceToNow(new Date(date), {
                        addSuffix: true,
                        locale: enUS,
                    })}
                </div>
            );
        },
        enableSorting: true,
        enableHiding: false,
    },
    {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
            const log = row.original;

            return (
                <LogDetailsModal log={log}>
                    <Button size="sm" variant="helper" className="h-8 w-8 p-0">
                        <EyeIcon className="h-4 w-4" />
                    </Button>
                </LogDetailsModal>
            );
        },
        enableSorting: false,
        enableHiding: false,
    },
];
