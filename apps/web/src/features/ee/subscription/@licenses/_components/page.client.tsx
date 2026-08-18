"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { DataTable } from "@components/ui/data-table";
import { magicModal } from "@components/ui/magic-modal";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { createOrUpdateOrganizationParameter } from "@services/organizationParameters/fetch";
import {
    OrganizationParametersConfigKey,
    type OrganizationParametersAutoAssignConfig,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    AlertTriangleIcon,
    RefreshCwIcon,
    UserMinusIcon,
    UserPlusIcon,
} from "lucide-react";
import { Skeleton } from "@components/ui/skeleton";
import { AsyncBoundary } from "src/core/components/async-boundary";
import { Switch } from "src/core/components/ui/switch";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { TableFilterContext } from "../../_providers/table-filter-context";
import { refreshOrganizationMembers } from "../../_services/billing/fetch";
import { AssignByGitIdButton } from "./assign-by-git-id-modal";
import { columns, type LicenseTableRow } from "./columns";
import { PruneSeatsModal } from "./prune-seats-modal";

const DEFAULT_REVOKE_GRACE_DAYS = 7;

export const LicensesPageClient = ({
    data,
    autoLicenseAssignmentConfig,
    membersUnavailable = false,
}: {
    data: LicenseTableRow[];
    autoLicenseAssignmentConfig?: OrganizationParametersAutoAssignConfig;
    membersUnavailable?: boolean;
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

    // Always merge into the stored config: it also carries the auto-revoke
    // settings and the pending-revocation timers written by the cron.
    const saveAutoAssignConfig = (
        patch: Partial<OrganizationParametersAutoAssignConfig>,
    ) =>
        createOrUpdateOrganizationParameter(
            OrganizationParametersConfigKey.AUTO_LICENSE_ASSIGNMENT,
            {
                enabled: false,
                ignoredUsers: [],
                ...autoLicenseAssignmentConfig,
                ...patch,
            },
        );

    const [handleToggle, { loading: isToggling }] = useAsyncAction(
        async (checked: boolean) => {
            try {
                await saveAutoAssignConfig({ enabled: checked });

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

    const [handleAutoRevokeToggle, { loading: isTogglingAutoRevoke }] =
        useAsyncAction(async (checked: boolean) => {
            try {
                await saveAutoAssignConfig({ autoRevokeRemovedUsers: checked });

                toast({
                    variant: "success",
                    title: checked
                        ? "Seats will be released automatically"
                        : "Automatic seat release turned off",
                });

                router.refresh();
            } catch {
                toast({
                    variant: "danger",
                    title: "Failed to update automatic seat release",
                });
            }
        });

    const [handleIgnoredUsersChange, { loading: isSavingIgnoredUsers }] =
        useAsyncAction(async () => {
            try {
                await saveAutoAssignConfig({
                    ignoredUsers: pendingIgnoredUsers,
                });

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

    const reclaimableSeats = data.filter(
        (row) => row.removedFromGit && row.licenseStatus === "active",
    );

    const canAssignSeats =
        subscription.status === "active" ||
        subscription.status === "licensed-self-hosted";

    const openPruneModal = () =>
        magicModal.show(() => (
            <PruneSeatsModal
                teamId={teamId}
                candidates={reclaimableSeats.map((row) => ({
                    id: String(row.id),
                    name: row.name,
                }))}
                onPruned={() => router.refresh()}
            />
        ));

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

                        <div className="border-card-lv2 flex items-center justify-between border-t pt-4">
                            <div className="space-y-0.5">
                                <div className="text-base font-medium">
                                    Release seats automatically
                                </div>
                                <div className="text-muted-foreground text-sm">
                                    Free up a license{" "}
                                    {autoLicenseAssignmentConfig?.revokeGraceDays ??
                                        DEFAULT_REVOKE_GRACE_DAYS}{" "}
                                    days after a member leaves your git
                                    organization.
                                </div>
                            </div>
                            <Switch
                                checked={
                                    autoLicenseAssignmentConfig?.autoRevokeRemovedUsers ??
                                    false
                                }
                                onCheckedChange={handleAutoRevokeToggle}
                                loading={isTogglingAutoRevoke}
                                disabled={isTogglingAutoRevoke}
                            />
                        </div>
                    </div>
                )}
            {membersUnavailable && (
                <div className="text-warning border-warning/40 bg-warning/10 flex items-start gap-2 rounded-lg border p-3 text-sm">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                    <span className="text-pretty">
                        We couldn&apos;t reach your code platform, so we
                        can&apos;t tell who left the organization. Members shown
                        here may be incomplete and seat cleanup is paused. If
                        someone you need to license is missing, use{" "}
                        <b>Assign by git ID</b> to give them a seat anyway.
                    </span>
                </div>
            )}
            <div className="flex justify-end gap-2">
                {canEdit && canAssignSeats && (
                    <AsyncBoundary
                        errorVariant="silent"
                        skeleton={<Skeleton className="h-8 w-36" />}>
                        <AssignByGitIdButton
                            onAssigned={() => router.refresh()}
                        />
                    </AsyncBoundary>
                )}
                {canEdit && reclaimableSeats.length > 0 && (
                    <Button
                        size="sm"
                        variant="helper"
                        leftIcon={<UserMinusIcon />}
                        onClick={openPruneModal}>
                        Release {reclaimableSeats.length} unused{" "}
                        {reclaimableSeats.length === 1 ? "seat" : "seats"}
                    </Button>
                )}
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
