"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { ArrowUpCircle } from "lucide-react";

import { MembersFact, PlanFact, PlanSheet } from "../../_components/plan-sheet";
import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

export const FreeByok = ({
    members,
}: {
    members: TeamMembersResponse["members"];
}) => {
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
            facts={
                <>
                    <MembersFact count={members.length} />
                    <PlanFact
                        label="Models"
                        value="BYOK"
                        detail="Your key pays for every review."
                    />
                </>
            }
        />
    );
};
