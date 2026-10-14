"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ArrowUpCircle } from "lucide-react";

import { PlanSheet } from "../../_components/plan-sheet";
import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

/**
 * Billing answered but holds no license for the organization — its trial
 * was never provisioned. Without a valid license the review gate refuses
 * the org, so reviews aren't running until a plan exists.
 */
export const NoPlan = () => {
    const subscription = useSubscriptionStatus();
    const router = useRouter();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);

    if (subscription.status !== "no-license") return null;

    return (
        <PlanSheet
            tone="neutral"
            chip="No plan"
            title="No subscription"
            summary="This workspace doesn't have a plan yet, so Kody isn't reviewing. Choose one to start."
            actions={
                <Button
                    size="md"
                    variant="primary"
                    disabled={!canEdit}
                    leftIcon={<ArrowUpCircle />}
                    onClick={() => router.push("/choose-plan")}>
                    Choose a plan
                </Button>
            }
        />
    );
};
