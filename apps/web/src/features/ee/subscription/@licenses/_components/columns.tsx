"use client";

import { Badge } from "@components/ui/badge";
import { magicModal } from "@components/ui/magic-modal";
import { Switch } from "@components/ui/switch";
import { useAsyncAction } from "@hooks/use-async-action";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useSuspenseGetConnections } from "@services/setup/hooks";
import { ColumnDef, Row } from "@tanstack/react-table";
import { AsyncBoundary } from "src/core/components/async-boundary";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { assignOrDeassignUserLicenseAction } from "../../_actions/assign-or-deassign-license";
import { NoMoreLicensesModal } from "./no-more-licenses-modal";

export type LicenseTableRow = {
    id: string | number;
    name: string;
    licenseStatus: "active" | "inactive";
    removedFromGit?: boolean;
};

const LicenseAssignmentCell = ({ row }: { row: Row<LicenseTableRow> }) => {
    const subscription = useSubscriptionStatus();
    const { teamId } = useSelectedTeamId();
    const connections = useSuspenseGetConnections(teamId);
    const canEdit = usePermission(Action.Update, ResourceType.UserSettings);

    const codeManagementConnection = connections.find(
        (connection) => connection.category === "CODE_MANAGEMENT",
    );

    const [
        assignOrDeassignLicense,
        { loading: isAssigningOrDeassigningLicense },
    ] = useAsyncAction(
        async (licenseStatus: LicenseTableRow["licenseStatus"]) => {
            await assignOrDeassignUserLicenseAction({
                teamId,
                user: {
                    git_id: String(row.original.id),
                    git_tool:
                        codeManagementConnection?.platformName.toLowerCase()!,
                    licenseStatus,
                },
                userName: row.original.name,
            });
        },
    );

    const canToggleOn =
        !row.original.removedFromGit &&
        (subscription.status === "active" ||
            subscription.status === "licensed-self-hosted") &&
        subscription.usersWithAssignedLicense.length <
            subscription.numberOfLicenses;

    return (
        <Switch
            loading={isAssigningOrDeassigningLicense}
            checked={row.original.licenseStatus === "active"}
            disabled={
                !canEdit ||
                (subscription.status !== "active" &&
                    subscription.status !== "licensed-self-hosted") ||
                (row.original.removedFromGit &&
                    row.original.licenseStatus === "inactive")
            }
            onCheckedChange={async () => {
                if (
                    row.original.removedFromGit &&
                    row.original.licenseStatus === "inactive"
                ) {
                    return;
                }

                if (
                    (subscription.status === "active" ||
                        subscription.status === "licensed-self-hosted") &&
                    subscription.usersWithAssignedLicense.length >=
                        subscription.numberOfLicenses &&
                    row.original.licenseStatus === "inactive" &&
                    canToggleOn
                ) {
                    magicModal.show(() => (
                        <NoMoreLicensesModal teamId={teamId} />
                    ));
                    return;
                }

                assignOrDeassignLicense(
                    row.original.licenseStatus === "active"
                        ? "inactive"
                        : "active",
                );
            }}
        />
    );
};

export const columns: ColumnDef<LicenseTableRow>[] = [
    {
        accessorKey: "name",
        header: "Username",
        size: 150,
        cell: ({ row }) => (
            <div className="flex items-center gap-2">
                <span>{row.original.name}</span>
                {row.original.removedFromGit && (
                    <Badge variant="outline" className="text-muted-foreground shrink-0">
                        Removed from organization
                    </Badge>
                )}
            </div>
        ),
    },
    {
        header: "License assignment",
        cell: ({ row }) => (
            <AsyncBoundary errorVariant="minimal">
                <LicenseAssignmentCell row={row} />
            </AsyncBoundary>
        ),
    },
];
