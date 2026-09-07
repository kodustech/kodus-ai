"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader, CardTitle } from "@components/ui/card";
import { useAsyncAction } from "@hooks/use-async-action";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { CircleDollarSign } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { pluralize } from "src/core/utils/string";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { createManageBillingLinkAction } from "../../_actions/create-manage-billing-link";

export const Active = ({
    members,
}: {
    members: TeamMembersResponse["members"];
}) => {
    const { teamId } = useSelectedTeamId();
    const subscription = useSubscriptionStatus();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    if (subscription.status !== "active") return null;

    const totalLicenses = subscription.numberOfLicenses;

    const assignedLicenses = subscription.usersWithAssignedLicense.length;
    const organizationAdminsCount = members.length;

    const [
        createLinkToManageBilling,
        { loading: isCreatingLinkToManageBilling },
    ] = useAsyncAction(async () => {
        const { url } = await createManageBillingLinkAction({ teamId });
        window.location.href = url;
    });

    const formattedPlanName = subscription.planType
        .replace("_byok", "")
        .replaceAll("_", " ");

    return (
        <Card className="w-full">
            <CardHeader className="flex flex-row justify-between gap-2">
                <div className="flex flex-col gap-2">
                    <p className="text-text-secondary text-sm">
                        Paid subscription {subscription.byok && "(BYOK)"}
                    </p>
                    <CardTitle className="text-2xl">
                        <span className="capitalize">{formattedPlanName}</span>{" "}
                        plan
                    </CardTitle>

                    <div className="mt-4 flex gap-6">
                        <p className="text-text-secondary text-sm">
                            <strong>{assignedLicenses}</strong> of{" "}
                            <strong>{totalLicenses}</strong> licenses assigned
                        </p>

                        <p className="text-text-secondary text-sm">
                            <strong>{organizationAdminsCount}</strong> workspace{" "}
                            {pluralize(organizationAdminsCount, {
                                singular: "member",
                                plural: "members",
                            })}
                        </p>
                    </div>
                </div>

                <Button
                    size="md"
                    variant="primary"
                    className="h-fit"
                    leftIcon={<CircleDollarSign />}
                    loading={isCreatingLinkToManageBilling}
                    disabled={!canEdit}
                    onClick={() => createLinkToManageBilling()}>
                    Manage billing
                </Button>
            </CardHeader>
        </Card>
    );
};
