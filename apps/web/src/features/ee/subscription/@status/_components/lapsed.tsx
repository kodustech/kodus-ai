"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ArrowUpCircle, CreditCardIcon } from "lucide-react";

import { PlanSheet, SeatsFact } from "../../_components/plan-sheet";
import { useManageBilling } from "../../_hooks/use-manage-billing";
import { tierOf } from "../../_utils/plan-tone";

/**
 * A paid plan that stopped: payment failed, canceled or expired. Billing
 * keeps these licenses invalid and the review gate refuses them, so the
 * sheet says reviews stopped and offers the way back: the Stripe portal while
 * the subscription still exists (a failed payment — the card is the fix), the
 * plans once it doesn't (canceled or expired — the portal has no "subscribe"
 * for those, only invoices and the card).
 */
export const LapsedPlan = ({
    chip,
    planType,
    summary,
    action,
    seats,
}: {
    chip: string;
    planType?: string;
    summary: string;
    action: { label: string; to: "portal" | "plans" };
    seats: { used: number; total: number };
}) => {
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const [openBilling, { loading }] = useManageBilling();
    const router = useRouter();
    const toPlans = action.to === "plans";

    return (
        <PlanSheet
            tone="danger"
            chip={chip}
            title={tierOf(planType) ?? "Subscription"}
            summary={summary}
            actions={
                <Button
                    size="md"
                    variant="primary"
                    leftIcon={toPlans ? <ArrowUpCircle /> : <CreditCardIcon />}
                    loading={!toPlans && loading}
                    disabled={!canEdit}
                    onClick={() =>
                        toPlans ? router.push("/choose-plan") : openBilling()
                    }>
                    {action.label}
                </Button>
            }
            facts={
                seats.total > 0 ? (
                    <SeatsFact
                        used={seats.used}
                        total={seats.total}
                        tone="danger"
                    />
                ) : undefined
            }
        />
    );
};
