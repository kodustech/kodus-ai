"use client";

import { differenceInDays } from "date-fns";

import { useSubscriptionContext } from "../_providers/subscription-context";
import type {
    OrganizationLicense,
    OrganizationLicenseTrial,
    PlanType,
    TrialReviewCredits,
    TrialUnlock,
} from "../_services/billing/types";

type SubscriptionContextLicense = OrganizationLicense;

type TrialSubscriptionStatus = {
    status: "trial-active" | "trial-expiring" | "trial-exhausted";
    valid: true;
    trialEnd: string;
    trialDaysLeft: number;
    byok?: boolean;
    trialReviewCredits?: TrialReviewCredits;
    trialCreditTier?: OrganizationLicenseTrial["trialCreditTier"];
    trialUnlocks?: TrialUnlock[];
};

type InvalidSubscriptionStatus = {
    valid: false;
    numberOfLicenses: number;
    usersWithAssignedLicense: { git_id: string }[];
    status: "payment-failed" | "canceled" | "expired" | "inactive";
    planType?: PlanType;
    stripeCustomerId?: string | null;
};

type FreeSubscriptionStatus = {
    valid: true;
    byok: true;
    status: "free";
    planType: "free_byok";
};

type ActiveSubscriptionStatus = {
    valid: true;
    status: "active";
    numberOfLicenses: number;
    byok: boolean;
    usersWithAssignedLicense: { git_id: string }[];
    planType: PlanType;
};

type SelfHostedSubscriptionStatus = {
    valid: true;
    status: "self-hosted";
};

type LicensedSelfHostedSubscriptionStatus = {
    valid: true;
    status: "licensed-self-hosted";
    planType: string;
    numberOfLicenses: number;
    usersWithAssignedLicense: { git_id: string }[];
    expiresAt?: string;
    daysRemaining?: number;
};

type SubscriptionStatus =
    | ActiveSubscriptionStatus
    | TrialSubscriptionStatus
    | InvalidSubscriptionStatus
    | SelfHostedSubscriptionStatus
    | LicensedSelfHostedSubscriptionStatus
    | FreeSubscriptionStatus;

const getTrialReviewCredits = (
    license: OrganizationLicenseTrial,
): TrialReviewCredits | undefined => {
    const hasCreditData =
        typeof license.trialReviewCreditsTotal === "number" ||
        typeof license.trialReviewCreditsUsed === "number" ||
        typeof license.trialReviewCreditsRemaining === "number" ||
        Boolean(license.trialCreditTier);

    if (!hasCreditData) {
        return undefined;
    }

    return {
        total: license.trialReviewCreditsTotal,
        used: license.trialReviewCreditsUsed,
        remaining: license.trialReviewCreditsRemaining,
        tier: license.trialCreditTier,
    };
};

export const useSubscriptionStatus = (): SubscriptionStatus => {
    const subscription = useSubscriptionContext();
    const license = subscription.license as SubscriptionContextLicense;

    if (license.valid) {
        if (subscription.license.subscriptionStatus === "self-hosted") {
            return {
                valid: true,
                status: "self-hosted",
            };
        }

        if (
            subscription.license.subscriptionStatus === "licensed-self-hosted"
        ) {
            const expiresAt = (subscription.license as any).expiresAt as
                | string
                | undefined;
            const daysRemaining = expiresAt
                ? differenceInDays(new Date(expiresAt), new Date())
                : undefined;

            return {
                valid: true,
                status: "licensed-self-hosted",
                planType:
                    (subscription.license as any).planType || "enterprise",
                numberOfLicenses:
                    (subscription.license as any).numberOfLicenses || 0,
                usersWithAssignedLicense: subscription.usersWithAssignedLicense,
                expiresAt,
                daysRemaining,
            };
        }

        // Active subscription
        if (license.subscriptionStatus === "active") {
            const byok = license.planType.toLowerCase().includes("byok");

            if (license.planType === "free_byok") {
                return {
                    valid: true,
                    byok: true,
                    planType: license.planType,
                    status: "free",
                };
            }

            return {
                byok,
                valid: true,
                status: "active",
                planType: license.planType,
                numberOfLicenses: license.numberOfLicenses,
                usersWithAssignedLicense: subscription.usersWithAssignedLicense,
            };
        }

        // Trial
        if (license.subscriptionStatus === "trial") {
            const daysLeft = differenceInDays(license.trialEnd, new Date());
            const trialReviewCredits = getTrialReviewCredits(license);
            const trialBase = {
                valid: true as const,
                trialEnd: license.trialEnd,
                trialDaysLeft: daysLeft,
                byok: license.byok,
                trialReviewCredits,
                trialCreditTier: license.trialCreditTier,
                trialUnlocks: license.trialUnlocks,
            };

            if (license.byok !== true && trialReviewCredits?.remaining === 0) {
                return {
                    ...trialBase,
                    status: "trial-exhausted",
                };
            }

            if (
                // If the trial is not expired, but expiring in 3 days or less
                differenceInDays(new Date(), license.trialEnd) >= -3
            ) {
                return {
                    ...trialBase,
                    status: "trial-expiring",
                };
            }

            return {
                ...trialBase,
                status: "trial-active",
            };
        }
    }

    if (!license.valid) {
        return {
            valid: false,
            numberOfLicenses: license.numberOfLicenses || 0,
            status:
                license.subscriptionStatus === "payment_failed"
                    ? "payment-failed"
                    : license.subscriptionStatus,
            usersWithAssignedLicense: subscription.usersWithAssignedLicense,
            planType: license.planType,
            stripeCustomerId: license.stripeCustomerId,
        };
    }

    return {
        valid: false,
        numberOfLicenses: 0,
        status: "inactive",
        usersWithAssignedLicense: subscription.usersWithAssignedLicense,
    };
};
