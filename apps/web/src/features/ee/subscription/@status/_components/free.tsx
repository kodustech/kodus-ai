"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ArrowUpCircle } from "lucide-react";

import { PlanSheet } from "../../_components/plan-sheet";
import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

export const FreeByok = () => {
    const subscription = useSubscriptionStatus();
    const router = useRouter();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);

    if (subscription.status !== "free") return null;

    return (
        <PlanSheet
            tone="neutral"
            chip="Free"
            title="Free"
            summary="Reviews run on your own AI key, with no review limit. Upgrade for the Team features."
            actions={
                <Button
                    size="md"
                    variant="primary"
                    disabled={!canEdit}
                    leftIcon={<ArrowUpCircle />}
                    onClick={() => router.push("/choose-plan")}>
                    Upgrade
                </Button>
            }
        />
    );
};
