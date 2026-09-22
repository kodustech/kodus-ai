"use client";

import type { TeamMembersResponse } from "@services/setup/types";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { LapsedPlan } from "./lapsed";

export const PaymentFailed = ({
    members,
}: {
    members: TeamMembersResponse["members"];
}) => {
    const subscription = useSubscriptionStatus();
    if (subscription.status !== "payment-failed") return null;

    // The fix is the card on the subscription that exists, in the portal —
    // not a new Checkout, which would start a second subscription.
    return (
        <LapsedPlan
            chip="Payment failed"
            planType={subscription.planType}
            summary="The last payment didn't go through, so reviews are paused until billing is updated."
            action="Update payment method"
            seats={{
                used: subscription.usersWithAssignedLicense.length,
                total: subscription.numberOfLicenses,
            }}
            members={members}
        />
    );
};
