"use client";

import type { ElementType } from "react";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Progress } from "@components/ui/progress";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    Building2Icon,
    CheckIcon,
    GitPullRequestIcon,
    KeyRoundIcon,
    MailCheckIcon,
    SparklesIcon,
    UsersIcon,
} from "lucide-react";

import { TRIAL_DAYS } from "../_constants/trial";
import type {
    TrialCreditTier,
    TrialReviewCredits,
    TrialUnlock,
} from "../_services/billing/types";
import {
    getTrialCardState,
    getTrialCreditBalance,
    getTrialUnlocks,
    type TrialUnlockViewModel,
} from "../_utils/trial";
import { RequestExtensionPopover } from "./request-extension-popover";

const unlockIconByKey: Record<string, ElementType> = {
    company_email: MailCheckIcon,
    team_setup: UsersIcon,
    code_org_10_plus: Building2Icon,
    byok: KeyRoundIcon,
    manual_extension: GitPullRequestIcon,
};

const isDoneStatus = (status: TrialUnlockViewModel["status"]) =>
    status === "completed" || status === "claimed";

const UnlockRow = ({ unlock }: { unlock: TrialUnlockViewModel }) => {
    const Icon = unlockIconByKey[unlock.key] ?? SparklesIcon;
    const done = isDoneStatus(unlock.status);

    const cta = done ? (
        <span className="text-success flex items-center gap-1 text-xs font-medium">
            <CheckIcon className="size-3.5" />
            Done
        </span>
    ) : unlock.kind === "signal" ? (
        <span className="text-text-tertiary text-xs">
            {unlock.pendingLabel ?? "Pending"}
        </span>
    ) : unlock.actionType === "request_extension" ? (
        <RequestExtensionPopover triggerLabel={unlock.actionLabel} />
    ) : unlock.href ? (
        <Link href={unlock.href} noHoverUnderline>
            <Button decorative size="xs" variant="helper">
                {unlock.actionLabel ?? "Open"}
            </Button>
        </Link>
    ) : null;

    return (
        <div className="flex items-center gap-3">
            <Icon
                className={`size-4 shrink-0 ${done ? "text-success" : "text-text-tertiary"}`}
            />
            <div className="min-w-0 flex-1">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <p className="text-text-primary w-fit cursor-help text-sm decoration-dotted underline-offset-4 hover:underline">
                            {unlock.title}
                            <span className="text-text-tertiary ml-2 text-xs">
                                {unlock.rewardLabel}
                            </span>
                        </p>
                    </TooltipTrigger>
                    <TooltipContent
                        side="top"
                        align="start"
                        className="max-w-xs text-xs">
                        {unlock.description}
                    </TooltipContent>
                </Tooltip>
            </div>
            <div className="flex shrink-0 items-center">{cta}</div>
        </div>
    );
};

export const TrialCreditsSummary = ({
    credits,
    trialUnlocks,
    byok,
    daysLeft,
    companyEmailVerified,
    workspaceMembersCount,
    codeHostMembersCount,
    compact = false,
}: {
    credits?: TrialReviewCredits;
    trialCreditTier?: TrialCreditTier;
    trialUnlocks?: TrialUnlock[];
    byok?: boolean;
    daysLeft?: number;
    companyEmailVerified?: boolean;
    workspaceMembersCount?: number;
    codeHostMembersCount?: number;
    compact?: boolean;
}) => {
    const balance = getTrialCreditBalance(credits);
    const unlocks = getTrialUnlocks({
        billingUnlocks: trialUnlocks,
        byok,
        companyEmailVerified,
        workspaceMembersCount,
        codeHostMembersCount,
    });
    // Actionable items first, automatic signals last; done items sink within
    // their group so the next thing to do is always on top.
    const sortedUnlocks = [...unlocks].sort((a, b) => {
        const rank = (u: TrialUnlockViewModel) =>
            (u.kind === "action" ? 0 : 2) + (isDoneStatus(u.status) ? 1 : 0);
        return rank(a) - rank(b);
    });
    const daysLeftValue = typeof daysLeft === "number" ? daysLeft : TRIAL_DAYS;
    // Legacy trials (started before the credit model shipped) have no live
    // credit data — they keep the old "unlimited during the trial" behavior.
    // The credit UI only shows for trials that actually carry credits.
    const showCredits =
        getTrialCardState({ byok, hasCredits: balance.hasLiveData }) ===
        "credits";
    const trialReviewCopy = byok
        ? "Unlimited reviews — they run on your key."
        : showCredits
          ? `${balance.remaining} of ${balance.total} free reviews left while you try.`
          : "Unlimited reviews during your trial.";

    return (
        <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
                <div>
                    <p className="text-text-primary text-base font-semibold">
                        {byok
                            ? "You're all set — reviews are unlimited"
                            : showCredits
                              ? "You're trying Kody for free"
                              : "You're on a Team trial"}
                    </p>
                    <p className="text-text-secondary mt-1 text-sm">
                        {byok
                            ? `Reviews run on your AI key, so there's no review limit. Your ${TRIAL_DAYS}-day trial just unlocks the full Team features.`
                            : showCredits
                              ? `Reviews run on your AI key — free and unlimited, on any plan. To let you start with zero setup, we cover your first ${balance.total} reviews. Add your key anytime to keep going.`
                              : `Reviews are unlimited during your ${TRIAL_DAYS}-day trial. Connect your AI key anytime to keep them unlimited after it ends.`}
                    </p>
                </div>

                <div className="border-card-lv3 grid grid-cols-1 gap-4 border-y py-3 md:grid-cols-2">
                    <div>
                        <p className="text-text-tertiary text-xs font-semibold uppercase">
                            Team trial
                        </p>
                        <p className="text-text-primary mt-1 text-xl font-semibold">
                            {daysLeftValue} days
                        </p>
                        <p className="text-text-secondary mt-1 text-xs">
                            Full Team features for {daysLeftValue} more days.
                        </p>
                    </div>

                    <div>
                        <p className="text-text-tertiary text-xs font-semibold uppercase">
                            {byok
                                ? "Your AI key"
                                : showCredits
                                  ? "Reviews on us"
                                  : "Reviews"}
                        </p>
                        <p
                            className={`mt-1 text-xl font-semibold ${showCredits ? "text-text-primary" : "text-success"}`}>
                            {byok
                                ? "Connected"
                                : showCredits
                                  ? `${balance.remaining} of ${balance.total}`
                                  : "Unlimited"}
                        </p>
                        <p className="text-text-secondary mt-1 text-xs">
                            {trialReviewCopy}
                        </p>
                    </div>
                </div>

                {byok ? (
                    <div className="bg-success/10 text-success flex items-start gap-2 rounded-lg p-3 text-sm">
                        <SparklesIcon className="mt-0.5 size-4 shrink-0" />
                        <p>
                            Your AI key is connected, so reviews are unlimited —
                            on any plan, even after the trial ends.
                        </p>
                    </div>
                ) : showCredits ? (
                    <div className="flex flex-col gap-2">
                        <Progress
                            value={balance.used}
                            max={balance.total}
                            variant={
                                balance.remaining === 0 ? "tertiary" : "primary"
                            }
                        />
                        <p className="text-text-tertiary text-xs">
                            Trial reviews run on a model we pick for you.
                            Connect your own key to run frontier models for the
                            best quality.
                        </p>
                    </div>
                ) : (
                    <p className="text-text-tertiary text-xs">
                        Trial reviews run on a model we pick for you. Connect
                        your own key to run frontier models for the best
                        quality.
                    </p>
                )}
            </div>

            {!compact && showCredits && sortedUnlocks.length > 0 && (
                <div className="border-card-lv3 flex flex-col gap-3 border-t pt-4">
                    <div>
                        <p className="text-text-primary text-sm font-semibold">
                            Keep reviews running
                        </p>
                        <p className="text-text-secondary mt-1 text-xs">
                            Connect your AI key for unlimited reviews (free, any
                            plan), or earn a few more trial reviews on us.
                        </p>
                    </div>

                    <TooltipProvider delayDuration={150}>
                        <div className="flex flex-col gap-3.5">
                            {sortedUnlocks.map((unlock) => (
                                <UnlockRow key={unlock.key} unlock={unlock} />
                            ))}
                        </div>
                    </TooltipProvider>
                </div>
            )}
        </section>
    );
};
