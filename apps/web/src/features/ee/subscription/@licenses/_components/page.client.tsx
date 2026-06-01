"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { DataTable } from "@components/ui/data-table";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import {
    OrganizationParametersConfigKey,
    type OrganizationParametersAutoAssignConfig,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { RefreshCwIcon } from "lucide-react";
import { Switch } from "src/core/components/ui/switch";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { TableFilterContext } from "../../_providers/table-filter-context";
import { refreshOrganizationMembers } from "../../_services/billing/fetch";
import { columns, type LicenseTableRow } from "./columns";

export const LicensesPageClient = ({
    data,
    autoLicenseAssignmentConfig,
}: {
    data: LicenseTableRow[];
    autoLicenseAssignmentConfig?: OrganizationParametersAutoAssignConfig;
}) => {
    const { query, setQuery } = use(TableFilterContext);
    const router = useRouter();
    const { teamId } = useSelectedTeamId();

    const subscription = useSubscriptionStatus();
    const canEdit = usePermission(Action.Update, ResourceType.UserSettings);

    const [handleRefreshMembers, { loading: isRefreshing }] = useAsyncAction(
        async () => {
            try {
                await refreshOrganizationMembers({ teamId });
                router.refresh();
            } catch {
                toast({
                    variant: "danger",
                    title: "Failed to refresh members",
                });
            }
        },
    );

    const [open, setOpen] = useState(false);
    const [pendingIgnoredUsers, setPendingIgnoredUsers] = useState<string[]>(
        autoLicenseAssignmentConfig?.ignoredUsers ?? [],
    );

    const [handleToggle, { loading: isToggling }] = useAsyncAction(
        async (checked: boolean) => {
            try {
                await createOrUpdateOrganizationParameter(
                    OrganizationParametersConfigKey.AUTO_LICENSE_ASSIGNMENT,
                    {
                        enabled: checked,
                        ignoredUsers:
                            autoLicenseAssignmentConfig?.ignoredUsers || [],
                        allowedUsers:
                            autoLicenseAssignmentConfig?.allowedUsers || [],
                    },
                );

                toast({
                    variant: "success",
                    title: "Auto license assignment updated",
                });

                router.refresh();
            } catch {
                toast({
                    variant: "danger",
                    title: "Failed to update auto license assignment",
                });
            }
        },
    );

    const [handleIgnoredUsersChange, { loading: isSavingIgnoredUsers }] =
        useAsyncAction(async () => {
            try {
                await createOrUpdateOrganizationParameter(
                    OrganizationParametersConfigKey.AUTO_LICENSE_ASSIGNMENT,
                    {
                        enabled: autoLicenseAssignmentConfig?.enabled || false,
                        ignoredUsers: pendingIgnoredUsers,
                    },
                );

                toast({
                    variant: "success",
                    title: "Ignored users updated",
                });

                setOpen(false);
                router.refresh();
            } catch {
                toast({
                    variant: "danger",
                    title: "Failed to update ignored users",
                });
            }
        });

    const toggleUser = (userId: string) => {
        setPendingIgnoredUsers((current) =>
            current.includes(userId)
                ? current.filter((id) => id !== userId)
                : [...current, userId],
        );
    };

    return (
        <div className="flex flex-col gap-4">
            {canEdit &&
                (subscription.status === "active" ||
                    subscription.status === "licensed-self-hosted") && (
                    <div className="flex flex-col gap-4 rounded-lg border p-4">
                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <div className="text-base font-medium">
                                    Auto-assign licenses
                                </div>
                                <div className="text-muted-foreground text-sm">
                                    Automatically assign licenses to new members
                                    when they join the organization.
                                </div>
                            </div>
                            <Switch
                                checked={
                                    autoLicenseAssignmentConfig?.enabled ??
                                    false
                                }
                                onCheckedChange={handleToggle}
                                loading={isToggling}
                                disabled={isToggling}
                            />
                        </div>
                    </div>
                )}
            <div className="flex justify-end">
                <Button
                    size="sm"
                    variant="helper"
                    leftIcon={
                        <RefreshCwIcon
                            className={isRefreshing ? "animate-spin" : ""}
                        />
                    }
                    disabled={isRefreshing}
                    onClick={handleRefreshMembers}>
                    Refresh members
                </Button>
            </div>
            <DataTable
                data={data}
                columns={columns}
                state={{ globalFilter: query }}
                onGlobalFilterChange={setQuery}
            />
        </div>
    );
};
