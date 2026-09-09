"use client";

import { Link } from "@components/ui/link";
import { useKodusCredits } from "src/features/ee/subscription/_hooks/use-kodus-credits";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

const TrialExpiring = () => {
    const subscriptionStatus = useSubscriptionStatus();
    const daysLeft =
        subscriptionStatus.status === "trial-expiring"
            ? subscriptionStatus.trialDaysLeft
            : 0;

    return (
        <div className="bg-danger/30 py-2 text-center text-sm">
            Your Team trial expires in {daysLeft} days.{" "}
            <Link href="/settings/subscription" className="font-bold">
                Upgrade
            </Link>{" "}
            to keep all features.
        </div>
    );
};

const TrialExhausted = () => {
    return (
        <div className="bg-danger/30 py-2 text-center text-sm">
            You've used all the free PR reviews included in your trial.{" "}
            <Link href="/byok" className="font-bold">
                Connect your own AI key
            </Link>{" "}
            to keep Kody reviewing — unlimited, on any plan.
        </div>
    );
};

const SubscriptionInvalid = () => {
    return (
        <div className="bg-danger/30 py-2 text-center text-sm">
            Kody's off duty!{" "}
            <Link href="/settings/subscription" className="font-bold">
                Upgrade
            </Link>{" "}
            subscription to bring her back to work.
        </div>
    );
};

const components: Partial<
    Record<
        ReturnType<typeof useSubscriptionStatus>["status"],
        React.ComponentType
    >
> = {
    "trial-expiring": TrialExpiring,
    "trial-exhausted": TrialExhausted,
    "expired": SubscriptionInvalid,
    "canceled": SubscriptionInvalid,
    "payment-failed": SubscriptionInvalid,
};

const CreditsExhausted = () => {
    return (
        <div className="bg-danger/30 py-2 text-center text-sm">
            Your Kodus credits are used up — reviews on Kodus-routed models are
            paused.{" "}
            <Link href="/byok?tab=credits" className="font-bold">
                Top up credits
            </Link>{" "}
            or{" "}
            <Link href="/byok" className="font-bold">
                connect your own AI key
            </Link>
            .
        </div>
    );
};

export const SubscriptionStatusTopbar = () => {
    const { status } = useSubscriptionStatus();
    const credits = useKodusCredits();
    const Component = components[status];

    // An exhausted prepaid balance blocks reviews regardless of the plan
    // state, so it shows alongside (above) the plan banner — an expired plan
    // is still expired.
    if (credits.exhausted) {
        return (
            <div>
                <CreditsExhausted />
                {Component && <Component />}
            </div>
        );
    }

    if (!Component) return null;
    return (
        <div>
            <Component />
        </div>
    );
};
