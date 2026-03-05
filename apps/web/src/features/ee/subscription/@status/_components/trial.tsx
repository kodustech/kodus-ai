"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardHeader, CardTitle } from "@components/ui/card";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { ArrowUpCircle } from "lucide-react";
import { pluralize } from "src/core/utils/string";

import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

export const Trial = ({
    members,
    forceShow = false,
}: {
    members: TeamMembersResponse["members"];
    forceShow?: boolean;
}) => {
    const organizationAdminsCount = members.length;
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const router = useRouter();

    const subscriptionStatus = useSubscriptionStatus();

    if (!forceShow) {
        if (
            subscriptionStatus.status !== "trial-active" &&
            subscriptionStatus.status !== "trial-expiring"
        ) {
            return null;
        }
    }

    const isTrial =
        subscriptionStatus.status === "trial-active" ||
        subscriptionStatus.status === "trial-expiring";

    return (
        <Card className="w-full">
            <CardHeader className="flex flex-row justify-between gap-2">
                <div className="flex flex-col gap-2">
                    {isTrial &&
                        subscriptionStatus.trialDaysLeft !== undefined && (
                            <p className="text-text-secondary text-sm">
                                {subscriptionStatus.trialDaysLeft} days free
                                trial
                            </p>
                        )}
                    <CardTitle className="text-2xl">PRO plan</CardTitle>

                    <div className="mt-4 flex gap-6">
                        {/* <p className="text-sm text-text-secondary">
                            <strong>5</strong> of <strong>7</strong> licenses
                            assigned
                        </p> */}

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
                    size="lg"
                    variant="primary"
                    className="h-fit"
                    disabled={!canEdit}
                    leftIcon={<ArrowUpCircle />}
                    onClick={() => router.push("/choose-plan")}>
                    Upgrade
                </Button>
            </CardHeader>
        </Card>
    );
};
