"use client";

import { Badge } from "@components/ui/badge";
import { magicModal } from "@components/ui/magic-modal";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
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
    isBot?: boolean;
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
            const { failures } = await assignOrDeassignUserLicenseAction({
                teamId,
                user: {
                    git_id: String(row.original.id),
                    git_tool:
                        codeManagementConnection?.platformName.toLowerCase()!,
                    licenseStatus,
                },
                userName: row.original.name,
            });

            // A refused seat comes back in the payload, not as a thrown error:
            // unchecked, the switch just stayed off and nobody said why.
            const failure = failures?.[0];
            if (failure) {
                toast({
                    variant: "danger",
                    title:
                        licenseStatus === "active"
                            ? `Could not assign a seat to ${row.original.name}`
                            : `Could not release ${row.original.name}'s seat`,
                    description:
                        typeof failure.error === "string"
                            ? failure.error
                            : undefined,
                });
            }
        },
    );

    const isLicensed =
        subscription.status === "active" ||
        subscription.status === "licensed-self-hosted";

    return (
        <Switch
            loading={isAssigningOrDeassigningLicense}
            checked={row.original.licenseStatus === "active"}
            disabled={
                !canEdit ||
                !isLicensed ||
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

                // Every seat is taken: say so instead of sending a request the
                // server can only refuse.
                if (
                    isLicensed &&
                    row.original.licenseStatus === "inactive" &&
                    subscription.usersWithAssignedLicense.length >=
                        subscription.numberOfLicenses
                ) {
                    magicModal.show(() => (
                        <NoMoreLicensesModal
                            teamId={teamId}
                            seats={subscription.numberOfLicenses}
                        />
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
                {row.original.isBot && (
                    <Badge variant="helper" className="shrink-0">
                        Bot
                    </Badge>
                )}
                {row.original.removedFromGit && (
                    <Badge variant="helper" className="shrink-0">
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
