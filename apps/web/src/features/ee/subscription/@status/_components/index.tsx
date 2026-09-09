"use client";

import type { TeamMembersResponse } from "@services/setup/types";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";
import {
    SubscriptionProvider,
    useSubscriptionContext,
} from "src/features/ee/subscription/_providers/subscription-context";
import type { OrganizationLicenseTrial } from "src/features/ee/subscription/_services/billing/types";

import { CreditsCard } from "../../_components/credits-card";
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
                }
                // The nested provider must carry the app-level flag, or the
                // credits card on a trial org forgets it routes through Kodus.
                usesKodusProvider={subscriptionContext.usesKodusProvider}>
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
            return (
                <div className="flex flex-col gap-4">
                    <Expired members={members} />
                    <CreditsCard />
                </div>
            );
        }

        return (
            <div className="flex flex-col gap-4">
                <Trial members={members} forceShow />
                <CreditsCard />
            </div>
        );
    }

    const Component = components[status];

    if (!Component) return null;
    return (
        <div className="flex flex-col gap-4">
            <Component
                members={members}
                codeHostMembersCount={codeHostMembersCount}
            />
            {/* Prepaid credits ("Kodus as the provider") — renders nothing
                for an org that neither routes through Kodus nor bought any. */}
            <CreditsCard />
        </div>
    );
};
