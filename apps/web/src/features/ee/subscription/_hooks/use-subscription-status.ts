"use client";

import { differenceInDays } from "date-fns";

import { useSubscriptionContext } from "../_providers/subscription-context";
import type { PlanType } from "../_services/billing/types";

type SubscriptionContextLicense =
    | {
          valid: false;
          subscriptionStatus: "payment_failed" | "canceled" | "expired";
          numberOfLicenses: number;
          planType?: PlanType;
          stripeCustomerId?: string | null;
      }
    | {
          valid: true;
          subscriptionStatus: "trial";
          trialEnd: string;
      }
    | {
          valid: true;
          subscriptionStatus: "active";
          numberOfLicenses: number;
          planType: PlanType;
      };

type TrialSubscriptionStatus = {
    status: "trial-active" | "trial-expiring";
    valid: true;
    trialEnd: string;
    trialDaysLeft: number;
};

type InvalidSubscriptionStatus = {
    valid: false;
    numberOfLicenses: number;
    usersWithAssignedLicense: { git_id: string }[];
    status: "payment-failed" | "canceled" | "expired";
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

            if (
                // If the trial is not expired, but expiring in 3 days or less
                differenceInDays(new Date(), license.trialEnd) >= -3
            ) {
                return {
                    valid: true,
                    trialEnd: license.trialEnd,
                    trialDaysLeft: daysLeft,
                    status: "trial-expiring",
                };
            }

            return {
                valid: true,
                trialEnd: license.trialEnd,
                trialDaysLeft: daysLeft,
                status: "trial-active",
            };
        }
    }

    // Caso inválido
    return {
        valid: false,
        numberOfLicenses: (license as any).numberOfLicenses || 0,
        status:
            license.subscriptionStatus === "payment_failed"
                ? "payment-failed"
                : license.subscriptionStatus,
        usersWithAssignedLicense: subscription.usersWithAssignedLicense,
        planType: (license as any).planType,
        stripeCustomerId: (license as any).stripeCustomerId,
    };
};
