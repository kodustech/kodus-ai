"use client";

import { useContext, useEffect, useState } from "react";
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
import { roleUsesRepoAssignment } from "@libs/identity/domain/permissions/policies/role-policies";
import { useGetSelectedRepositories } from "@services/codeManagement/hooks";
import { getAssignedRepos } from "@services/permissions/fetch";
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
    Plus,
    TrashIcon,
} from "lucide-react";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { ClipboardHelpers } from "src/core/utils/clipboard";
import { safeArray } from "src/core/utils/safe-array";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";

import AssignReposModal from "./assign-repos.modal";
import { DeleteModal } from "./delete-modal";

function AssignedReposLink({
    userId,
    canEdit,
}: {
    userId: string;
    canEdit: boolean;
}) {
    const { teamId } = useSelectedTeamId();
    const { data: allRepositories = [] } = useGetSelectedRepositories(teamId);
    const [repoNames, setRepoNames] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const fetchRepoNames = async () => {
        setIsLoading(true);
        try {
            const assignedIds = await getAssignedRepos(userId);
            const assignedSet = new Set(assignedIds);
            const names = safeArray(allRepositories)
                .filter((repo) => assignedSet.has(repo.id))
                .map((repo) => repo.name);
            setRepoNames(names);
        } catch {
            setRepoNames([]);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (allRepositories.length > 0) {
            fetchRepoNames();
        } else {
            setRepoNames([]);
            setIsLoading(false);
        }
    }, [userId, allRepositories]);

    const openModal = () => {
        magicModal.show(() => (
            <AssignReposModal userId={userId} onSave={fetchRepoNames} />
        ));
    };

    if (isLoading) {
        return (
            <span className="text-text-secondary text-xs">Loading...</span>
        );
    }

    return (
        <div className="flex w-full items-center gap-1.5">
            {repoNames.length > 0 ? (
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div className="text-text-secondary flex flex-col text-xs">
                                <span className="truncate">
                                    {repoNames[0]}
                                </span>
                                {repoNames.length === 2 && (
                                    <span className="truncate">
                                        {repoNames[1]}
                                    </span>
                                )}
                                {repoNames.length >= 3 && (
                                    <span className="text-text-secondary/70 cursor-default">
                                        +{repoNames.length - 1} more...
                                    </span>
                                )}
                            </div>
                        </TooltipTrigger>
                        {repoNames.length >= 3 && (
                            <TooltipContent side="bottom">
                                <div className="flex flex-col gap-0.5">
                                    {repoNames.map((name) => (
                                        <span key={name}>{name}</span>
                                    ))}
                                </div>
                            </TooltipContent>
                        )}
                    </Tooltip>
                </TooltipProvider>
            ) : (
                <span className="text-text-secondary text-xs">
                    No repositories
                </span>
            )}
            {canEdit && (
                <button
                    type="button"
                    onClick={openModal}
                    className="bg-primary-light/10 text-primary-light hover:bg-primary-light/20 flex shrink-0 cursor-pointer items-center rounded-full p-0.5">
                    <Plus className="size-3.5" />
                </button>
            )}
        </div>
    );
}

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

            // Only show the chip for roles where assignment actually gates
            // something (repo-scoped grants in ROLE_POLICIES) — for the rest
            // (e.g. read-only org-wide Contributor) it would be a no-op.
            const shouldShowButton = roleUsesRepoAssignment(rowRole);

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
                            <AssignedReposLink
                                userId={row.original.userId!}
                                canEdit={canEdit}
                            />
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
            const { userId } = useAuth();
            const canEdit = usePermission(
                Action.Update,
                ResourceType.UserSettings,
            );
            const canDelete = usePermission(
                Action.Delete,
                ResourceType.UserSettings,
            );
            const isSelf = row.original.userId === userId;

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

            if (isSelf) {
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
                    </div>
                );
            }

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

                            {!isSelf && (
                                <DropdownMenuItem
                                    leftIcon={<CopyIcon />}
                                    disabled={!canEdit}
                                    onSelect={() => {
                                        const inviteLink = `${window.location.origin}/invite/${row.original.userId}`;
                                        const copied =
                                            ClipboardHelpers.copyTextToClipboard(
                                                inviteLink,
                                            );

                                        toast(
                                            copied
                                                ? {
                                                    variant: "info",
                                                    title: "Copied to clipboard the invite link",
                                                    description: (
                                                        <span className="text-text-secondary">
                                                            for user with email{" "}
                                                            <span className="text-text-primary">
                                                                {
                                                                    row.original
                                                                        .email
                                                                }
                                                            </span>
                                                        </span>
                                                    ),
                                                }
                                                : {
                                                    variant: "danger",
                                                    title: "Couldn't copy the invite link",
                                                    description: (
                                                        <span className="text-text-secondary">
                                                            Copy it manually:{" "}
                                                            <span className="text-text-primary">
                                                                {inviteLink}
                                                            </span>
                                                        </span>
                                                    ),
                                                },
                                        );
                                    }}>
                                    Copy invite link
                                </DropdownMenuItem>
                            )}

                            {!isSelf && (
                                <>
                                    <DropdownMenuSeparator />

                                    <DropdownMenuItem
                                        className="text-danger"
                                        leftIcon={<TrashIcon />}
                                        disabled={!canDelete}
                                        onClick={() =>
                                            magicModal.show(() => (
                                                <DeleteModal
                                                    member={row.original}
                                                />
                                            ))
                                        }>
                                        Delete
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            );
        },
    },
];
