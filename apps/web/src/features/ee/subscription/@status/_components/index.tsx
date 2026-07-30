"use client";

import type { TeamMembersResponse } from "@services/setup/types";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";
import {
    SubscriptionProvider,
    useSubscriptionContext,
} from "src/features/ee/subscription/_providers/subscription-context";
import type { OrganizationLicenseTrial } from "src/features/ee/subscription/_services/billing/types";

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
    "trial-exhausted": Trial,
    "free": FreeByok,
    "canceled": Canceled,
    "payment-failed": PaymentFailed,
};

export const Redirect = ({
    members,
    codeHostMembersCount,
    trialLicense,
}: {
    members: TeamMembersResponse["members"];
    codeHostMembersCount?: number;
    trialLicense?: OrganizationLicenseTrial;
}) => {
    const subscriptionContext = useSubscriptionContext();

    if (trialLicense) {
        return (
            <SubscriptionProvider
                license={trialLicense}
                usersWithAssignedLicense={
                    subscriptionContext.usersWithAssignedLicense
                }>
                <RedirectContent
                    members={members}
                    codeHostMembersCount={codeHostMembersCount}
                />
            </SubscriptionProvider>
        );
    }

    return (
        <RedirectContent
            members={members}
            codeHostMembersCount={codeHostMembersCount}
        />
    );
};

const RedirectContent = ({
    members,
    codeHostMembersCount,
}: {
    members: TeamMembersResponse["members"];
    codeHostMembersCount?: number;
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
    return (
        <Component
            members={members}
            codeHostMembersCount={codeHostMembersCount}
        />
    );
};
