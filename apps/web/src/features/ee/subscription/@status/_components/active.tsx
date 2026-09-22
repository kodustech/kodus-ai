"use client";

import { Button } from "@components/ui/button";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { CreditCardIcon } from "lucide-react";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import {
    MembersFact,
    PlanFact,
    PlanSheet,
    SeatsFact,
} from "../../_components/plan-sheet";
import { useManageBilling } from "../../_hooks/use-manage-billing";
import {
    billingIntervalOf,
    modelsOf,
    tierOf,
    toneOfTier,
} from "../../_utils/plan-tone";

export const Active = ({
    members,
}: {
    members: TeamMembersResponse["members"];
}) => {
    const subscription = useSubscriptionStatus();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const [openBilling, { loading }] = useManageBilling();

    if (subscription.status !== "active") return null;

    const tier = tierOf(subscription.planType) ?? "Paid plan";
    const tone = toneOfTier(tier);
    const models = modelsOf(subscription.planType);

    return (
        <PlanSheet
            tone={tone}
            chip={tier}
            title={tier}
            summary={`${billingIntervalOf(subscription.planType)} through Stripe. ${
                models === "BYOK"
                    ? "Reviews run on your own AI key."
                    : "Kodus runs the models your reviews use."
            }`}
            actions={
                <Button
                    size="md"
                    variant="primary"
                    leftIcon={<CreditCardIcon />}
                    loading={loading}
                    disabled={!canEdit}
                    onClick={() => openBilling()}>
                    Manage billing
                </Button>
            }
            facts={
                <>
                    {subscription.numberOfLicenses > 0 && (
                        <SeatsFact
                            used={subscription.usersWithAssignedLicense.length}
                            total={subscription.numberOfLicenses}
                            tone={tone}
                        />
                    )}
                    <MembersFact count={members.length} />
                    <PlanFact
                        label="Models"
                        value={models}
                        detail={
                            models === "BYOK"
                                ? "Your key pays for every review."
                                : "Provided by Kodus."
                        }
                    />
                </>
            }
        />
    );
};
