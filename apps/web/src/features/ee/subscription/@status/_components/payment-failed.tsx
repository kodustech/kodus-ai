"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardHeader, CardTitle } from "@components/ui/card";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { AlertTriangle, CircleDollarSign } from "lucide-react";
import { pluralize } from "src/core/utils/string";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

export const PaymentFailed = ({
    members,
}: {
    members: TeamMembersResponse["members"];
}) => {
    const subscription = useSubscriptionStatus();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const router = useRouter();
    if (subscription.status !== "payment-failed") return null;

    const totalLicenses = subscription.numberOfLicenses;

    const assignedLicenses = subscription.usersWithAssignedLicense.length;
    const organizationAdminsCount = members.length;

    return (
        <Card className="w-full">
            <CardHeader className="flex flex-row justify-between gap-2">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-1.5">
                        <AlertTriangle className="text-danger size-4" />

                        <span className="text-danger text-sm">
                            Payment failed
                        </span>
                    </div>
                    <CardTitle className="text-2xl">PRO plan</CardTitle>

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
                    disabled={!canEdit}
                    leftIcon={<CircleDollarSign />}
                    onClick={() => router.push("/choose-plan")}>
                    Subscribe again
                </Button>
            </CardHeader>
        </Card>
    );
};
