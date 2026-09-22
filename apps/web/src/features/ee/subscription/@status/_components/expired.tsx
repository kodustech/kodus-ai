"use client";

import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { LapsedPlan } from "./lapsed";

export const Expired = () => {
    const subscription = useSubscriptionStatus();
    if (subscription.status !== "expired") return null;

    return (
        <LapsedPlan
            chip="Expired"
            planType={subscription.planType}
            summary="The subscription expired, so reviews are paused until you subscribe again."
            action="Subscribe again"
            seats={{
                used: subscription.usersWithAssignedLicense.length,
                total: subscription.numberOfLicenses,
            }}
        />
    );
};
