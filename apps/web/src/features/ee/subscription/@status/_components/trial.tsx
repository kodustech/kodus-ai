"use client";

import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { TeamMembersResponse } from "@services/setup/types";
import { ArrowUpCircle, KeyRoundIcon } from "lucide-react";

import { MembersFact, PlanFact, PlanSheet } from "../../_components/plan-sheet";
import { TrialCreditsSummary } from "../../_components/trial-credits-summary";
import { TRIAL_DAYS } from "../../_constants/trial";
import { useSubscriptionStatus } from "../../_hooks/use-subscription-status";
import { getTrialCardState, getTrialCreditBalance } from "../../_utils/trial";

export const Trial = ({
    members,
    codeHostMembersCount,
    forceShow = false,
}: {
    members: TeamMembersResponse["members"];
    codeHostMembersCount?: number;
    forceShow?: boolean;
}) => {
    const canEdit = usePermission(Action.Update, ResourceType.Billing);
    const router = useRouter();
    const subscriptionStatus = useSubscriptionStatus();

    const isTrial =
        subscriptionStatus.status === "trial-active" ||
        subscriptionStatus.status === "trial-expiring" ||
        subscriptionStatus.status === "trial-exhausted";

    if (!forceShow && !isTrial) return null;

    const choosePlan = (primary: boolean) => (
        <Button
            size="md"
            variant={primary ? "primary" : "helper"}
            disabled={!canEdit}
            leftIcon={<ArrowUpCircle />}
            onClick={() => router.push("/choose-plan")}>
            Choose a plan
        </Button>
    );

    if (!isTrial) {
        return (
            <PlanSheet
                tone="neutral"
                chip="Trial ended"
                title="Team trial"
                summary="Your Team trial has ended. Upgrade to keep PR reviews running."
                actions={choosePlan(true)}
            />
        );
    }

    const daysLeft = Math.max(subscriptionStatus.trialDaysLeft, 0);
    const expiring = subscriptionStatus.status === "trial-expiring";
    const exhausted = subscriptionStatus.status === "trial-exhausted";
    const days = `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
    const byok = subscriptionStatus.byok;
    const balance = getTrialCreditBalance(
        subscriptionStatus.trialReviewCredits,
    );
    // Legacy trials carry no credit data and keep unlimited reviews.
    const reviews = getTrialCardState({
        byok,
        hasCredits: balance.hasLiveData,
    });

    return (
        <PlanSheet
            tone="primary"
            chip="Trial"
            title="Team trial"
            summary={
                exhausted
                    ? "Your free reviews are used up. Connect your AI key to keep reviewing — unlimited, on any plan."
                    : expiring
                      ? `${days} left. Choose a plan to keep the Team features.`
                      : `${days} left in your ${TRIAL_DAYS}-day trial of the Team features.`
            }
            summaryClassName={
                exhausted ? "text-alert" : expiring ? "text-warning" : undefined
            }
            actions={
                // Out of free reviews, a plan doesn't bring them back — a key
                // does. Choosing a plan stays, as the second way forward.
                exhausted ? (
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
                        {choosePlan(false)}
                    </>
                ) : (
                    choosePlan(true)
                )
            }
            facts={
                <>
                    <PlanFact
                        label="Trial"
                        value={`${days} left`}
                        detail="The Team features, until it ends."
                        detailClassName={expiring ? "text-warning" : undefined}
                    />
                    {reviews === "byok" ? (
                        <PlanFact
                            label="Your AI key"
                            value="Connected"
                            detail="Unlimited reviews — they run on your key."
                        />
                    ) : reviews === "credits" ? (
                        // Drains as reviews are spent, matching "N left".
                        <PlanFact
                            label="Reviews on us"
                            value={`${balance.remaining} of ${balance.total}`}
                            meter={{
                                share:
                                    balance.total > 0
                                        ? balance.remaining / balance.total
                                        : 0,
                                tone: "primary",
                            }}
                            detail={
                                exhausted
                                    ? "Used up. A key of your own keeps reviews running."
                                    : "Free reviews left while you try."
                            }
                            detailClassName={
                                exhausted ? "text-alert" : undefined
                            }
                        />
                    ) : (
                        <PlanFact
                            label="Reviews"
                            value="Unlimited"
                            detail="During your trial."
                        />
                    )}
                    <MembersFact count={members.length} />
                </>
            }>
            <TrialCreditsSummary
                credits={subscriptionStatus.trialReviewCredits}
                trialCreditTier={subscriptionStatus.trialCreditTier}
                trialUnlocks={subscriptionStatus.trialUnlocks}
                byok={subscriptionStatus.byok}
                workspaceMembersCount={members.length}
                codeHostMembersCount={codeHostMembersCount}
            />
        </PlanSheet>
    );
};
