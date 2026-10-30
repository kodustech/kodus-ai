"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { RefreshCwIcon } from "lucide-react";

import { PlanSheet } from "../../_components/plan-sheet";
import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

/**
 * What the app gets when billing didn't answer: the plan is unknown, not
 * gone, so there's nothing to choose or pay — only a retry. The license is
 * fetched by a server component, so re-running the route is the retry.
 */
export const Unverified = () => {
    const subscription = useSubscriptionStatus();
    const router = useRouter();
    const [retrying, startRetry] = useTransition();

    if (subscription.status !== "inactive") return null;

    return (
        <PlanSheet
            tone="neutral"
            chip="Unconfirmed"
            title="Plan unavailable"
            summary="Billing didn't answer, so your plan can't be shown right now. Your subscription hasn't changed."
            actions={
                <Button
                    size="md"
                    variant="helper"
                    leftIcon={<RefreshCwIcon />}
                    loading={retrying}
                    onClick={() => startRetry(() => router.refresh())}>
                    Try again
                </Button>
            }
        />
    );
};
