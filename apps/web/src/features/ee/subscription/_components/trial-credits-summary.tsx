"use client";

import type { ElementType } from "react";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
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
    InfoIcon,
    KeyRoundIcon,
    MailCheckIcon,
    SparklesIcon,
    UsersIcon,
} from "lucide-react";

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
    companyEmailVerified,
    workspaceMembersCount,
    codeHostMembersCount,
    compact = false,
}: {
    credits?: TrialReviewCredits;
    trialCreditTier?: TrialCreditTier;
    trialUnlocks?: TrialUnlock[];
    byok?: boolean;
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
    // Legacy trials (started before the credit model shipped) have no live
    // credit data — they keep the old "unlimited during the trial" behavior.
    // The credit UI only shows for trials that actually carry credits.
    const showCredits =
        getTrialCardState({ byok, hasCredits: balance.hasLiveData }) ===
        "credits";

    // Highlighted, non-BYOK-only disclosure: trial reviews run on our managed
    // models, and BYOK unlocks larger ones. Kept short so it reads as a callout.
    const trialModelsCopy =
        "Trial reviews run on efficient models we provide (DeepSeek V4 Flash on Fireworks, GPT Luna, Kimi K2.7). Connect your AI key for larger, frontier models.";

    // Days and reviews left are the plan sheet's facts; this is the part
    // under them — which models the trial uses, and how to keep reviewing.
    return (
        <section className="flex flex-col gap-5">
            {byok ? (
                <div className="bg-success/10 text-success flex items-start gap-2 rounded-lg p-3 text-sm">
                    <SparklesIcon className="mt-0.5 size-4 shrink-0" />
                    <p>
                        Your AI key is connected, so reviews are unlimited — on
                        any plan, even after the trial ends.
                    </p>
                </div>
            ) : (
                <div className="bg-primary-light/10 text-primary-light flex items-start gap-2 rounded-lg p-3 text-sm">
                    <InfoIcon className="mt-0.5 size-4 shrink-0" />
                    <p>{trialModelsCopy}</p>
                </div>
            )}

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
