import {
    TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED,
    TRIAL_UNLOCK_BYOK_REWARD_LABEL,
    TRIAL_UNLOCK_CODE_ORG_REWARD,
    TRIAL_UNLOCK_COMPANY_EMAIL_REWARD,
    TRIAL_UNLOCK_TEAM_REWARD,
} from "../_constants/trial";
import type {
    TrialCreditTier,
    TrialReviewCredits,
    TrialUnlock,
    TrialUnlockKey,
    TrialUnlockStatus,
} from "../_services/billing/types";

export type TrialCreditBalance = {
    total: number;
    used: number;
    remaining: number;
    hasLiveData: boolean;
    percentUsed: number;
};

export type TrialUnlockViewModel = {
    key: TrialUnlockKey;
    title: string;
    description: string;
    rewardLabel: string;
    status: TrialUnlockStatus;
    /**
     * `signal` unlocks are evaluated automatically by Kodus and the user
     * cannot trigger them directly (e.g. company email comes from the
     * signup address). `action` unlocks expose something the user can do
     * right now (invite teammates, manage the git connection, configure
     * BYOK, request a manual extension).
     */
    kind: "signal" | "action";
    href?: string;
    /** Label for the call-to-action button (action unlocks only). */
    actionLabel?: string;
    /** Special client-handled actions that don't navigate via href. */
    actionType?: "request_extension";
    /** Status label shown for a `signal` that has not qualified yet. */
    pendingLabel?: string;
};

/**
 * Which trial view to render:
 * - `byok`    → AI key connected, reviews unlimited.
 * - `credits` → new trial on the credit model (show "X of N", progress, unlocks).
 * - `legacy`  → trial started before the credit model (no live credit data) —
 *               unlimited like the old trial, no credit UI.
 */
export type TrialCardState = "byok" | "credits" | "legacy";

export const getTrialCardState = (params: {
    byok?: boolean;
    hasCredits: boolean;
}): TrialCardState => {
    if (params.byok) return "byok";
    if (params.hasCredits) return "credits";
    return "legacy";
};

export const getTrialCreditBalance = (
    credits?: TrialReviewCredits,
): TrialCreditBalance => {
    const hasLiveData =
        typeof credits?.total === "number" ||
        typeof credits?.used === "number" ||
        typeof credits?.remaining === "number";

    const fallbackTotal = TRIAL_MANAGED_REVIEW_CREDITS_INCLUDED;
    const total = Math.max(0, credits?.total ?? fallbackTotal);
    const used = Math.max(0, credits?.used ?? 0);
    const remaining = Math.max(
        0,
        credits?.remaining ?? Math.max(0, total - used),
    );
    const percentUsed = total > 0 ? Math.min(100, (used / total) * 100) : 100;

    return {
        total,
        used,
        remaining,
        hasLiveData,
        percentUsed,
    };
};

export const getTrialTierLabel = (tier?: TrialCreditTier): string => {
    switch (tier) {
        case "base":
            return "Base";
        case "team_signal":
            return "Team signal";
        case "qualified":
            return "Qualified";
        case "manual":
            return "Manual";
        default:
            return "Base";
    }
};

const fallbackUnlocks = (params: {
    byok?: boolean;
    companyEmailVerified?: boolean;
    workspaceMembersCount?: number;
    codeHostMembersCount?: number;
}): TrialUnlockViewModel[] => [
    {
        key: "company_email",
        title: "Company email",
        description: params.companyEmailVerified
            ? "We detected a work email, so this signal is qualified."
            : "Detected automatically from the email you signed up with. A work email (not a personal one) qualifies the trial — this only changes if you sign up again with a company address.",
        rewardLabel: `+${TRIAL_UNLOCK_COMPANY_EMAIL_REWARD} reviews`,
        status: params.companyEmailVerified ? "completed" : "locked",
        kind: "signal",
        pendingLabel: "Personal email",
    },
    {
        key: "code_org_10_plus",
        title: "10+ developer code org",
        description:
            params.codeHostMembersCount && params.codeHostMembersCount >= 10
                ? "Your connected code org has at least 10 members."
                : "Counts the members of the Git organization Kodus is connected to. Connect your org (not a personal account) — it qualifies automatically once it reaches 10 developers. Switching orgs requires reconnecting the integration.",
        rewardLabel: `+${TRIAL_UNLOCK_CODE_ORG_REWARD} reviews`,
        status:
            params.codeHostMembersCount && params.codeHostMembersCount >= 10
                ? "completed"
                : "available",
        kind: "action",
        href: "/settings/git",
        actionLabel: "Manage connection",
    },
    {
        key: "team_setup",
        title: "Invite 3 teammates",
        description:
            params.workspaceMembersCount && params.workspaceMembersCount >= 3
                ? "Your workspace already has enough teammates."
                : "Add teammates so the trial reflects a real review workflow.",
        rewardLabel: `+${TRIAL_UNLOCK_TEAM_REWARD} reviews`,
        status:
            params.workspaceMembersCount && params.workspaceMembersCount >= 3
                ? "completed"
                : "available",
        kind: "action",
        href: "/settings/subscription?tab=admins",
        actionLabel: "Invite teammates",
    },
    {
        key: "byok",
        title: "Connect BYOK",
        description:
            "Use your own AI key. Reviews no longer use Kodus-paid PRs.",
        rewardLabel: TRIAL_UNLOCK_BYOK_REWARD_LABEL,
        status: params.byok ? "completed" : "available",
        kind: "action",
        href: "/organization/byok",
        actionLabel: "Configure BYOK",
    },
    {
        key: "manual_extension",
        title: "Request more trial PR reviews",
        description:
            "Tell us about your team and we'll review your trial signals to extend the evaluation.",
        rewardLabel: "Manual review",
        status: "available",
        kind: "action",
        actionLabel: "Request review",
        actionType: "request_extension",
    },
];

const getBillingUnlockRewardLabel = (
    unlock: TrialUnlock,
    fallbackRewardLabel?: string,
) => {
    if (typeof unlock.rewardCredits === "number") {
        return `+${unlock.rewardCredits} reviews`;
    }

    return fallbackRewardLabel ?? "Manual review";
};

export const getTrialUnlocks = (params: {
    billingUnlocks?: TrialUnlock[];
    byok?: boolean;
    companyEmailVerified?: boolean;
    workspaceMembersCount?: number;
    codeHostMembersCount?: number;
}): TrialUnlockViewModel[] => {
    const fallback = fallbackUnlocks(params);
    const billingUnlocksByKey = new Map(
        params.billingUnlocks?.map((unlock) => [unlock.key, unlock]) ?? [],
    );
    const fallbackKeys = new Set(fallback.map((unlock) => unlock.key));

    const mergedFallbackUnlocks = fallback.map((unlock) => {
        const billingUnlock = billingUnlocksByKey.get(unlock.key);
        if (!billingUnlock) return unlock;

        return {
            ...unlock,
            title: billingUnlock.title || unlock.title,
            description: billingUnlock.description || unlock.description,
            rewardLabel: getBillingUnlockRewardLabel(
                billingUnlock,
                unlock.rewardLabel,
            ),
            status: billingUnlock.status,
        };
    });

    const billingOnlyUnlocks =
        params.billingUnlocks
            ?.filter((unlock) => !fallbackKeys.has(unlock.key))
            .map(
                (unlock): TrialUnlockViewModel => ({
                    key: unlock.key,
                    title: unlock.title || "Trial unlock",
                    description:
                        unlock.description ||
                        "This unlock can add more PR reviews to this trial.",
                    rewardLabel: getBillingUnlockRewardLabel(unlock),
                    status: unlock.status,
                    kind: "action",
                }),
            ) ?? [];

    return [...mergedFallbackUnlocks, ...billingOnlyUnlocks];
};
