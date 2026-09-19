"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { formatUsd } from "@services/usage/format";
import { useFeatureFlags } from "src/app/(app)/settings/_components/context";
import { useKodusCreditBalance } from "src/features/ee/byok/_hooks/use-kodus-credit-balance";
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
    // Private alpha: the Kodus-credits path is offered only to orgs on the flag.
    const { kodusProvider } = useFeatureFlags();
    return (
        <div className="bg-danger/30 py-2 text-center text-sm">
            You've used all the free PR reviews included in your trial.{" "}
            {kodusProvider ? (
                <>
                    <Link
                        href="/byok/manual?provider=kodus"
                        className="font-bold">
                        Use Kodus credits
                    </Link>{" "}
                    (no API key) or{" "}
                    <Link href="/byok" className="font-bold">
                        connect your own AI key
                    </Link>{" "}
                </>
            ) : (
                <>
                    <Link href="/byok" className="font-bold">
                        Connect your own AI key
                    </Link>{" "}
                </>
            )}
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

/**
 * The plan could not be verified — billing did not answer.
 *
 * This is NOT the same as billing answering "inactive", but both collapse to
 * the same state today, and the map below had no entry for it. A cloud
 * customer whose billing service is briefly unreachable therefore watched
 * every paid feature turn into a padlock with no explanation anywhere: it
 * reads as a silent downgrade instead of an outage. Gating is unchanged —
 * this only stops the app from going quiet about it.
 */
const SubscriptionUnverified = () => {
    const router = useRouter();
    const [retrying, setRetrying] = useState(false);

    // The licence is fetched by a server component, so re-running the route is
    // the retry. Nothing here is optimistic: if billing is still down the
    // banner simply comes back.
    const retry = () => {
        setRetrying(true);
        router.refresh();
        window.setTimeout(() => setRetrying(false), 2000);
    };

    return (
        <div className="bg-warning/25 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 py-2 text-center text-sm">
            <span>
                We can&apos;t reach billing, so your plan can&apos;t be
                confirmed — paid features stay locked until it answers.{" "}
                <strong className="font-semibold">
                    Your subscription hasn&apos;t changed.
                </strong>
            </span>
            <Button
                size="xs"
                variant="helper"
                loading={retrying}
                onClick={retry}>
                Try again
            </Button>
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
    // Was missing, which is why an unverifiable plan said nothing at all.
    "inactive": SubscriptionUnverified,
};

const CreditsExhausted = ({ neverFunded }: { neverFunded: boolean }) => {
    if (neverFunded) {
        return (
            <div className="bg-warning/25 py-2 text-center text-sm">
                Your Kodus model has no credits yet — reviews won&apos;t run
                until you{" "}
                <Link href="/byok#kodus" className="font-bold">
                    add credits
                </Link>
                .
            </div>
        );
    }
    return (
        <div className="bg-danger/30 py-2 text-center text-sm">
            Your Kodus credits are used up — reviews on Kodus-routed models are
            paused.{" "}
            <Link href="/byok#kodus" className="font-bold">
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

/**
 * The warning BEFORE the block. Exhausted already had a band; low had only
 * an amber tint on a number in the nav, which is not something anyone
 * notices in time to act on it. Same routing gate as exhausted: a balance
 * running low on an org that routes nothing through Kodus threatens nothing.
 */
const CreditsLow = ({ balanceUsd }: { balanceUsd: number | undefined }) => (
    <div className="bg-warning/25 py-2 text-center text-sm">
        Your Kodus credits are running low
        {typeof balanceUsd === "number" ? ` (${formatUsd(balanceUsd)})` : ""} —
        reviews on Kodus-routed models stop when they run out.{" "}
        <Link href="/byok#kodus" className="font-bold">
            Top up credits
        </Link>
        .
    </div>
);

export const SubscriptionStatusTopbar = () => {
    const { status } = useSubscriptionStatus();
    const credits = useKodusCreditBalance();
    const Component = components[status];

    // An exhausted prepaid balance blocks reviews regardless of the plan
    // state, so it shows alongside (above) the plan banner — an expired plan
    // is still expired. A never-funded org gets the "add credits to start"
    // framing rather than "used up".
    //
    // `usesKodusProvider` only says a Kodus model is configured. An org that
    // connected Kodus but left its own key as the org default routes nothing
    // through it, so a zero balance pauses nothing — announcing paused reviews
    // there is a false alarm on every page. The banner waits for routing to
    // confirm it.
    if (credits.exhausted && credits.routedThroughKodus) {
        return (
            <div>
                <CreditsExhausted neverFunded={credits.neverFunded} />
                {Component && <Component />}
            </div>
        );
    }

    // Same shape one step earlier: warn while there is still time to act.
    if (credits.low && credits.routedThroughKodus) {
        return (
            <div>
                <CreditsLow balanceUsd={credits.balanceUsd} />
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
