"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ArrowUpCircle, KeyRoundIcon } from "lucide-react";

import { PlanSheet } from "../../_components/plan-sheet";
import { useHasAiKey } from "../../_hooks/use-has-ai-key";
import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";

export const FreeByok = () => {
    const subscription = useSubscriptionStatus();
    const router = useRouter();
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const hasKey = useHasAiKey();

    if (subscription.status !== "free") return null;

    const upgrade = (primary: boolean) => (
        <Button
            size="md"
            variant={primary ? "primary" : "helper"}
            disabled={!canEdit}
            leftIcon={<ArrowUpCircle />}
            onClick={() => router.push("/choose-plan")}>
            Upgrade
        </Button>
    );

    // Free reviews only on a key of the org's own: without one, nothing
    // runs, and connecting it is the step before any plan question.
    return (
        <PlanSheet
            tone="neutral"
            chip="Free"
            title="Free"
            summary={
                hasKey
                    ? "Reviews run on your own AI key, with no review limit. Upgrade for the Team features."
                    : "Free reviews run on your own AI key, and none is connected yet — connect one and Kody starts reviewing."
            }
            summaryClassName={hasKey ? undefined : "text-alert"}
            actions={
                hasKey ? (
                    upgrade(true)
                ) : (
                    <>
                        <Link href="/byok" noHoverUnderline>
                            <Button
                                decorative
                                size="md"
                                variant="primary"
                                leftIcon={<KeyRoundIcon />}>
                                Connect your AI key
                            </Button>
                        </Link>
                        {upgrade(false)}
                    </>
                )
            }
        />
    );
};
