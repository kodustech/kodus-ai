"use client";

import type { TeamMembersResponse } from "@services/setup/types";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import { Active } from "./active";
import { Canceled } from "./canceled";
import { Expired } from "./expired";
import { FreeByok } from "./free";
import { PaymentFailed } from "./payment-failed";
import { Trial } from "./trial";

const components: Partial<
    Record<
        ReturnType<typeof useSubscriptionStatus>["status"],
        React.ComponentType<any>
    >
> = {
    "active": Active,
    "trial-active": Trial,
    "trial-expiring": Trial,
    "free": FreeByok,
    "canceled": Canceled,
    "payment-failed": PaymentFailed,
};

export const Redirect = ({
    members,
}: {
    members: TeamMembersResponse["members"];
}) => {
    const subscriptionStatus = useSubscriptionStatus();
    const { status } = subscriptionStatus;

    if (status === "expired") {
        const hasStripeCustomerId =
            subscriptionStatus.stripeCustomerId &&
            subscriptionStatus.stripeCustomerId.trim().length > 0;

        if (hasStripeCustomerId) {
            return <Expired members={members} />;
        }

        return <Trial members={members} forceShow />;
    }

    const Component = components[status];

    if (!Component) return null;
    return <Component members={members} />;
};
