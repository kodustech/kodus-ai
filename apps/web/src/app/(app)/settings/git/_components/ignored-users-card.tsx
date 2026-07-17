"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import {
    OrganizationParametersAutoAssignConfig,
    OrganizationParametersConfigKey,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { Check, ChevronsUpDown } from "lucide-react";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "src/core/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "src/core/components/ui/popover";
import { cn } from "src/core/utils/components";
import { useOrganizationContext } from "src/features/organization/_providers/organization-context";

type OrganizationMember = {
    id: string;
    name: string;
};

type FilterMode = "ignore" | "allow";

export const IgnoredUsersCard = ({
    organizationMembers,
    autoLicenseAssignmentConfig,
}: {
    organizationMembers: OrganizationMember[];
    autoLicenseAssignmentConfig?: OrganizationParametersAutoAssignConfig;
}) => {
    const { organizationId } = useOrganizationContext();
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<FilterMode>(
        (autoLicenseAssignmentConfig?.allowedUsers?.length ?? 0) > 0
            ? "allow"
            : "ignore",
    );
    const [pendingIgnoredUsers, setPendingIgnoredUsers] = useState<string[]>(
        autoLicenseAssignmentConfig?.ignoredUsers ?? [],
    );
    const [pendingAllowedUsers, setPendingAllowedUsers] = useState<string[]>(
        autoLicenseAssignmentConfig?.allowedUsers ?? [],
    );

    const resetPendingUsersFromConfig = () => {
        setPendingIgnoredUsers(autoLicenseAssignmentConfig?.ignoredUsers ?? []);
        setPendingAllowedUsers(autoLicenseAssignmentConfig?.allowedUsers ?? []);
    };

    const canEditGitSettings = usePermission(
        Action.Update,
        ResourceType.GitSettings,
    );

    const [handleIgnoredUsersChange, { loading: isSavingIgnoredUsers }] =
        useAsyncAction(async () => {
            try {
                await createOrUpdateOrganizationParameter(
                    OrganizationParametersConfigKey.AUTO_LICENSE_ASSIGNMENT,
                    {
                        enabled: autoLicenseAssignmentConfig?.enabled ?? false,
                        ignoredUsers:
                            mode === "ignore" ? pendingIgnoredUsers : [],
                        allowedUsers:
                            mode === "allow" ? pendingAllowedUsers : [],
                    },
                );

                toast({
                    variant: "success",
                    title: "PR author filters updated",
                });

                setOpen(false);
                router.refresh();
            } catch {
                toast({
                    variant: "danger",
                    title: "Failed to update PR author filters",
                });
            }
        });

    const [handleResetFilters, { loading: isResettingFilters }] =
        useAsyncAction(async () => {
            try {
                await createOrUpdateOrganizationParameter(
                    OrganizationParametersConfigKey.AUTO_LICENSE_ASSIGNMENT,
                    {
                        enabled: autoLicenseAssignmentConfig?.enabled ?? false,
                        ignoredUsers: [],
                        allowedUsers: [],
                    },
                );

                setPendingIgnoredUsers([]);
                setPendingAllowedUsers([]);
                setMode("ignore");

                toast({
                    variant: "success",
                    title: "PR author filters reset",
                });

                setOpen(false);
                router.refresh();
            } catch {
                toast({
                    variant: "danger",
                    title: "Failed to reset PR author filters",
                });
            }
        });

    const toggleUser = (userId: string) => {
        if (!canEditGitSettings || isResettingFilters || isSavingIgnoredUsers)
            return;

        if (mode === "ignore") {
            setPendingIgnoredUsers((current) =>
                current.includes(userId)
                    ? current.filter((id) => id !== userId)
                    : [...current, userId],
            );
        } else {
            setPendingAllowedUsers((current) =>
                current.includes(userId)
                    ? current.filter((id) => id !== userId)
                    : [...current, userId],
            );
        }
    };

    const selectedUsers =
        mode === "ignore" ? pendingIgnoredUsers : pendingAllowedUsers;

    const selectedCount = selectedUsers.filter((id) =>
        organizationMembers.some((user) => user.id === id),
    ).length;

    const modeLabel =
        mode === "ignore" ? "Excluded authors" : "Included authors";

    const selectionLabel =
        selectedCount > 0
            ? `${modeLabel} (${selectedCount} author${
                  selectedCount === 1 ? "" : "s"
              })`
            : `${modeLabel} (none)`;

    const currentEffect =
        mode === "ignore"
            ? `Currently reviewing: Everyone${
                  selectedCount > 0
                      ? ` (excluding ${selectedCount} author${selectedCount === 1 ? "" : "s"})`
                      : ""
              }`
            : `Currently reviewing: Only ${
                  selectedCount > 0 ? selectedCount : "selected"
              } author${selectedCount === 1 ? "" : "s"}`;

    return (
        <div className="mt-5 flex flex-col gap-4">
            <h2 className="text-md font-bold">
                Choose which PR authors Kody reviews in enabled repositories.
            </h2>
            <div className="space-y-4 pt-0">
                <div className="grid gap-3 md:grid-cols-2">
                    {[
                        {
                            value: "ignore",
                            title: "Exclude PR authors",
                            description:
                                "Kody won’t review PRs opened by these authors.",
                        },
                        {
                            value: "allow",
                            title: "Only these PR authors",
                            description:
                                "Kody will review PRs opened by these authors only.",
                        },
                    ].map((option) => {
                        const isActive = mode === option.value;
                        const isDisabled =
                            !canEditGitSettings ||
                            isResettingFilters ||
                            isSavingIgnoredUsers;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() =>
                                    !isDisabled &&
                                    setMode(option.value as FilterMode)
                                }
                                disabled={isDisabled}
                                className={cn(
                                    "flex h-full flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition",
                                    "hover:border-primary/60 hover:bg-card/60 focus-visible:ring-primary focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:outline-none",
                                    isActive
                                        ? "border-primary bg-card-lv2 border-primary-light"
                                        : "",
                                    isDisabled &&
                                        "cursor-not-allowed opacity-70",
                                )}>
                                <span className="text-sm font-semibold">
                                    {option.title}
                                </span>
                                <span className="text-muted-foreground text-xs">
                                    {option.description}
                                </span>
                            </button>
                        );
                    })}
                </div>

                <Popover
                    open={open}
                    onOpenChange={(isOpen) => {
                        if (isOpen) {
                            resetPendingUsersFromConfig();
                        }
                        setOpen(isOpen);
                    }}>
                    <PopoverTrigger asChild>
                        <Button
                            variant="helper"
                            size="lg"
                            role="combobox"
                            aria-expanded={open}
                            className="w-full justify-between"
                            disabled={
                                !canEditGitSettings ||
                                isResettingFilters ||
                                isSavingIgnoredUsers
                            }>
                            {selectionLabel}
                            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent
                        className="flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
                        align="start">
                        <Command className="min-h-0 flex-1">
                            <CommandInput placeholder="Search authors..." />
                            <CommandList className="max-h-none min-h-0 flex-1">
                                <CommandEmpty>No author found.</CommandEmpty>
                                <CommandGroup>
                                    {organizationMembers.map((user) => (
                                        <CommandItem
                                            key={user.id}
                                            value={user.name}
                                            disabled={
                                                !canEditGitSettings ||
                                                isResettingFilters ||
                                                isSavingIgnoredUsers
                                            }
                                            onSelect={() =>
                                                toggleUser(user.id.toString())
                                            }>
                                            {user.name}
                                            <Check
                                                className={cn(
                                                    "mr-2 size-4",
                                                    selectedUsers.includes(
                                                        user.id.toString(),
                                                    )
                                                        ? "opacity-100"
                                                        : "opacity-0",
                                                )}
                                            />
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            </CommandList>
                            <div className="flex shrink-0 items-center gap-2 border-t p-2">
                                <Button
                                    className="flex-1"
                                    size="sm"
                                    variant="cancel"
                                    onClick={handleResetFilters}
                                    loading={isResettingFilters}
                                    disabled={
                                        !canEditGitSettings ||
                                        isSavingIgnoredUsers
                                    }>
                                    Reset
                                </Button>
                                <Button
                                    className="flex-1"
                                    size="sm"
                                    variant="primary"
                                    onClick={handleIgnoredUsersChange}
                                    loading={isSavingIgnoredUsers}
                                    disabled={
                                        !canEditGitSettings ||
                                        isResettingFilters
                                    }>
                                    Apply
                                </Button>
                            </div>
                        </Command>
                    </PopoverContent>
                </Popover>

                <p className="text-muted-foreground text-xs">{currentEffect}</p>
            </div>
        </div>
    );
};
