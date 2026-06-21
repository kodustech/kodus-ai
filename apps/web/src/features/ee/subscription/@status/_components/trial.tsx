"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardHeader, CardTitle } from "@components/ui/card";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { ArrowUpCircle } from "lucide-react";

import { TrialCreditsSummary } from "../../_components/trial-credits-summary";
import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

export const Trial = ({
    members,
    codeHostMembersCount,
    forceShow = false,
}: {
    members: TeamMembersResponse["members"];
    codeHostMembersCount?: number;
    forceShow?: boolean;
}) => {
    const organizationAdminsCount = members.length;
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const router = useRouter();

    const subscriptionStatus = useSubscriptionStatus();

    if (!forceShow) {
        if (
            subscriptionStatus.status !== "trial-active" &&
            subscriptionStatus.status !== "trial-expiring" &&
            subscriptionStatus.status !== "trial-exhausted"
        ) {
            return null;
        }
    }

    const isTrial =
        subscriptionStatus.status === "trial-active" ||
        subscriptionStatus.status === "trial-expiring" ||
        subscriptionStatus.status === "trial-exhausted";

    return (
        <Card className="w-full">
            <CardHeader className="flex flex-col gap-6">
                <div className="flex flex-row justify-between gap-4">
                    <div className="flex flex-col gap-2">
                        {isTrial &&
                            subscriptionStatus.trialDaysLeft !== undefined && (
                                <p className="text-text-secondary text-sm">
                                    {subscriptionStatus.trialDaysLeft} days left
                                    in Team trial
                                </p>
                            )}
                        <CardTitle className="text-2xl">Team trial</CardTitle>
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
                </div>

                {isTrial && (
                    <TrialCreditsSummary
                        credits={subscriptionStatus.trialReviewCredits}
                        trialCreditTier={subscriptionStatus.trialCreditTier}
                        trialUnlocks={subscriptionStatus.trialUnlocks}
                        byok={subscriptionStatus.byok}
                        daysLeft={subscriptionStatus.trialDaysLeft}
                        workspaceMembersCount={organizationAdminsCount}
                        codeHostMembersCount={codeHostMembersCount}
                    />
                )}

                {!isTrial && (
                    <p className="text-text-secondary text-sm">
                        Your Team trial has ended. Upgrade to keep PR reviews
                        running.
                    </p>
                )}
            </CardHeader>
        </Card>
    );
};
