"use client";

import { Button } from "@components/ui/button";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { CreditCardIcon } from "lucide-react";

import {
    MembersFact,
    PlanSheet,
    SeatsFact,
} from "../../_components/plan-sheet";
import { useManageBilling } from "../../_hooks/use-manage-billing";
import { tierOf } from "../../_utils/plan-tone";

/**
 * A paid plan that stopped: payment failed, canceled or expired. Billing
 * keeps these licenses invalid and the review gate refuses them, so the
 * sheet says reviews stopped and offers the Stripe portal, where the card,
 * the invoice or the subscription gets fixed.
 */
export const LapsedPlan = ({
    chip,
    planType,
    summary,
    action,
    seats,
    members,
}: {
    chip: string;
    planType?: string;
    summary: string;
    action: string;
    seats: { used: number; total: number };
    members: TeamMembersResponse["members"];
}) => {
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const [openBilling, { loading }] = useManageBilling();

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
                    leftIcon={<CreditCardIcon />}
                    loading={loading}
                    disabled={!canEdit}
                    onClick={() => openBilling()}>
                    {action}
                </Button>
            }
            facts={
                <>
                    {seats.total > 0 && (
                        <SeatsFact
                            used={seats.used}
                            total={seats.total}
                            tone="danger"
                        />
                    )}
                    <MembersFact count={members.length} />
                </>
            }
        />
    );
};
