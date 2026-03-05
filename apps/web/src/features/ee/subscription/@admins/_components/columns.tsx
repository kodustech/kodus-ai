"use client";

import { useContext, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { DataTableColumnHeader } from "@components/ui/data-table";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { magicModal } from "@components/ui/magic-modal";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { toast } from "@components/ui/toaster/use-toast";
import { UserRole, UserStatus } from "@enums";
import { usePermission } from "@services/permissions/hooks";
import {
    Action,
    ResourceType,
    rolePriority,
} from "@services/permissions/types";
import { type MembersSetup } from "@services/setup/types";
import { updateUser } from "@services/users/fetch";
import { ColumnDef } from "@tanstack/react-table";
import {
    CheckIcon,
    ChevronsUpDown,
    CopyIcon,
    EllipsisVertical,
    Pencil,
    TrashIcon,
} from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { ClipboardHelpers } from "src/core/utils/clipboard";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import AssignReposModal from "./assign-repos.modal";
import { DeleteModal } from "./delete-modal";

export const columns: ColumnDef<MembersSetup>[] = [
    {
        id: "name",
        size: 120,
        minSize: 120,
        accessorFn: (r) => r.name,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Username" />
        ),
    },
    {
        id: "email",
        accessorFn: (r) => r.email,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Email" />
        ),
        cell: ({ row }) => {
            const isEmailPending =
                row.original.userStatus === UserStatus.EMAIL_PENDING;

            return (
                <div className="flex items-center gap-2">
                    <span>{row.original.email}</span>
                    {isEmailPending && (
                        <Badge
                            variant="in-progress"
                            className="pointer-events-none">
                            Email verification pending
                        </Badge>
                    )}
                </div>
            );
        },
    },
    {
        id: "role",
        size: 120,
        minSize: 120,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Role" />
        ),
        accessorFn: (r) => rolePriority[r.role],
        cell: ({ row }) => {
            const { userId } = useAuth();
            const canEdit = usePermission(
                Action.Update,
                ResourceType.UserSettings,
            );

            const rowRole = row.original.role;

            const role = rowRole
                .toLowerCase()
                .replaceAll("_", " ")
                .replace(/\b\w/g, (c) => c.toUpperCase());

            if (row.original.userId === userId || !canEdit) {
                return <span className="font-medium">{role}</span>;
            }

            const shouldShowButton = [
                UserRole.CONTRIBUTOR,
                UserRole.REPO_ADMIN,
            ].includes(rowRole);

            const updateRoleAction = async (newRole: UserRole) => {
                try {
                    await updateUser(row.original.userId!, { role: newRole });

                    toast({
                        variant: "success",
                        title: "Role updated",
                        description: (
                            <span>
                                Role for{" "}
                                <span className="text-primary-light">
                                    {row.original.email}
                                </span>{" "}
                                was changed to{" "}
                                <span className="font-medium capitalize">
                                    {newRole.toLowerCase().replaceAll("_", " ")}
                                </span>
                            </span>
                        ),
                    });

                    revalidateServerSidePath("/settings/subscription");
                } catch {
                    toast({
                        variant: "danger",
                        title: "Role was not updated",
                        description:
                            "Something wrong happened. Please, try again.",
                    });
                }
            };

            return (
                <div className="flex w-full items-center gap-2">
                    <div className="w-full">
                        <Select
                            value={rowRole}
                            onValueChange={(value) =>
                                updateRoleAction(value as UserRole)
                            }
                            disabled={
                                !canEdit ||
                                row.original.userStatus === UserStatus.INACTIVE
                            }>
                            <SelectTrigger className="w-full">
                                <SelectValue
                                    placeholder={
                                        row.original.userStatus ===
                                        UserStatus.INACTIVE
                                            ? "Inactive"
                                            : role
                                    }>
                                    {role}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {Object.values(UserRole).map((role) => (
                                    <SelectItem
                                        key={role}
                                        value={role}
                                        className="capitalize">
                                        {role
                                            .toLowerCase()
                                            .replaceAll("_", " ")}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {shouldShowButton && (
                        <div className="w-full">
                            <Button
                                variant="helper"
                                size="sm"
                                className="w-full gap-2 py-4"
                                disabled={!canEdit}
                                onClick={() =>
                                    magicModal.show(() => (
                                        <AssignReposModal
                                            userId={row.original.userId!}
                                        />
                                    ))
                                }>
                                <Pencil />
                                Repository access
                            </Button>
                        </div>
                    )}
                </div>
            );
        },
    },
    {
        size: 70,
        minSize: 70,
        id: "actions",
        header: "Actions",
        meta: { align: "right" },
        cell: ({ row }) => {
            const canEdit = usePermission(
                Action.Update,
                ResourceType.UserSettings,
            );
            const canDelete = usePermission(
                Action.Delete,
                ResourceType.UserSettings,
            );

            const approveUserAction = async () => {
                try {
                    await updateUser(row.original.userId!, {
                        status: UserStatus.ACTIVE,
                    });

                    toast({
                        variant: "success",
                        title: "User approved",
                        description: (
                            <span>
                                <span className="text-primary-light">
                                    {row.original.email}
                                </span>{" "}
                                <span>was approved</span>
                            </span>
                        ),
                    });

                    revalidateServerSidePath("/settings/subscription");
                } catch {
                    toast({
                        variant: "danger",
                        title: "User was not approved",
                        description:
                            "Something wrong happened. Please, try again.",
                    });
                }
            };

            return (
                <div className="flex w-fit items-center gap-3">
                    {row.original.userStatus ===
                        UserStatus.AWAITING_APPROVAL && (
                        <Button
                            size="xs"
                            variant="helper"
                            className="pointer-events-none">
                            Needs approval
                        </Button>
                    )}

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="cancel" size="icon-sm">
                                <EllipsisVertical />
                            </Button>
                        </DropdownMenuTrigger>

                        <DropdownMenuContent align="end">
                            {row.original.userStatus ===
                                UserStatus.AWAITING_APPROVAL && (
                                <>
                                    <DropdownMenuItem
                                        leftIcon={<CheckIcon />}
                                        className="text-success"
                                        disabled={!canEdit}
                                        onClick={() => approveUserAction()}>
                                        Approve
                                    </DropdownMenuItem>

                                    <DropdownMenuSeparator />
                                </>
                            )}

                            <DropdownMenuItem
                                leftIcon={<CopyIcon />}
                                disabled={!canEdit}
                                onClick={async () => {
                                    await ClipboardHelpers.copyTextToClipboard(
                                        `${window.location.origin}/invite/${row.original.userId}`,
                                    );

                                    toast({
                                        variant: "info",
                                        title: "Copied to clipboard the invite link",
                                        description: (
                                            <span className="text-text-secondary">
                                                for user with email{" "}
                                                <span className="text-text-primary">
                                                    {row.original.email}
                                                </span>
                                            </span>
                                        ),
                                    });
                                }}>
                                Copy invite link
                            </DropdownMenuItem>

                            <DropdownMenuSeparator />

                            <DropdownMenuItem
                                className="text-danger"
                                leftIcon={<TrashIcon />}
                                disabled={!canDelete}
                                onClick={() =>
                                    magicModal.show(() => (
                                        <DeleteModal member={row.original} />
                                    ))
                                }>
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            );
        },
    },
];
