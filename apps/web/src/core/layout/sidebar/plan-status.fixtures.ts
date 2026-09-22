import type { ComponentProps } from "react";
import type { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

type ProviderProps = ComponentProps<typeof SubscriptionProvider>;

export type PlanFixture = {
    id: string;
    title: string;
    license: ProviderProps["license"];
    usersWithAssignedLicense: ProviderProps["usersWithAssignedLicense"];
};

const DAY = 24 * 60 * 60 * 1000;

const users = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
        git_id: `user-${index}`,
        status: "active" as const,
    }));

/**
 * One billing answer per plan state the sidebar's plan panel draws, as the
 * layout would hand them to SubscriptionProvider. Dates are relative to
 * `now` so the day counts stay stable whatever day it runs.
 */
export const buildPlanFixtures = (now = Date.now()): PlanFixture[] => {
    // Half a day of slack: the status hook floors the difference in days.
    const inDays = (days: number) =>
        new Date(now + days * DAY + DAY / 2).toISOString();

    return [
        {
            id: "trial-active",
            title: "Trial",
            license: {
                valid: true,
                subscriptionStatus: "trial",
                planType: "teams_managed",
                trialEnd: inDays(12),
                trialReviewCreditsTotal: 10,
                trialReviewCreditsUsed: 3,
                trialReviewCreditsRemaining: 7,
            },
            usersWithAssignedLicense: [],
        },
        {
            id: "trial-byok",
            title: "Trial · BYOK",
            license: {
                valid: true,
                subscriptionStatus: "trial",
                planType: "teams_byok",
                trialEnd: inDays(9),
                byok: true,
            },
            usersWithAssignedLicense: [],
        },
        {
            id: "trial-expiring",
            title: "Trial · ending",
            license: {
                valid: true,
                subscriptionStatus: "trial",
                planType: "teams_managed",
                trialEnd: inDays(2),
                trialReviewCreditsTotal: 10,
                trialReviewCreditsUsed: 8,
                trialReviewCreditsRemaining: 2,
            },
            usersWithAssignedLicense: [],
        },
        {
            id: "trial-exhausted",
            title: "Trial · reviews used up",
            license: {
                valid: true,
                subscriptionStatus: "trial",
                planType: "teams_managed",
                trialEnd: inDays(6),
                trialReviewCreditsTotal: 10,
                trialReviewCreditsUsed: 10,
                trialReviewCreditsRemaining: 0,
            },
            usersWithAssignedLicense: [],
        },
        {
            // `byok` is the app layout's stamp: the org has its own key.
            id: "free",
            title: "Free",
            license: {
                valid: true,
                subscriptionStatus: "active",
                planType: "free_byok",
                numberOfLicenses: 0,
                byok: true,
            } as PlanFixture["license"],
            usersWithAssignedLicense: [],
        },
        {
            id: "free-no-key",
            title: "Free · no AI key",
            license: {
                valid: true,
                subscriptionStatus: "active",
                planType: "free_byok",
                numberOfLicenses: 0,
                byok: false,
            } as PlanFixture["license"],
            usersWithAssignedLicense: [],
        },
        {
            id: "teams",
            title: "Teams",
            license: {
                valid: true,
                subscriptionStatus: "active",
                planType: "teams_managed",
                numberOfLicenses: 25,
            },
            usersWithAssignedLicense: users(12),
        },
        {
            id: "teams-byok",
            title: "Teams · BYOK",
            license: {
                valid: true,
                subscriptionStatus: "active",
                planType: "teams_byok",
                numberOfLicenses: 10,
            },
            usersWithAssignedLicense: users(10),
        },
        {
            id: "enterprise",
            title: "Enterprise",
            license: {
                valid: true,
                subscriptionStatus: "active",
                planType: "enterprise_managed",
                numberOfLicenses: 200,
            },
            usersWithAssignedLicense: users(143),
        },
        {
            id: "community",
            title: "Community self-hosted",
            license: { valid: true, subscriptionStatus: "self-hosted" },
            usersWithAssignedLicense: [],
        },
        {
            id: "enterprise-self-hosted",
            title: "Enterprise self-hosted",
            license: {
                valid: true,
                subscriptionStatus: "licensed-self-hosted",
                planType: "enterprise",
                numberOfLicenses: 50,
                expiresAt: inDays(212),
            },
            usersWithAssignedLicense: users(31),
        },
        {
            id: "enterprise-self-hosted-ending",
            title: "Enterprise self-hosted · license ending",
            license: {
                valid: true,
                subscriptionStatus: "licensed-self-hosted",
                planType: "enterprise",
                numberOfLicenses: 50,
                expiresAt: inDays(18),
            },
            usersWithAssignedLicense: users(31),
        },
        {
            id: "enterprise-self-hosted-expired",
            title: "Enterprise self-hosted · license expired",
            license: {
                valid: true,
                subscriptionStatus: "licensed-self-hosted",
                planType: "enterprise",
                numberOfLicenses: 50,
                expiresAt: inDays(-3),
            },
            usersWithAssignedLicense: users(31),
        },
        {
            id: "payment-failed",
            title: "Payment failed",
            license: {
                valid: false,
                subscriptionStatus: "payment_failed",
                planType: "teams_managed",
                numberOfLicenses: 25,
            },
            usersWithAssignedLicense: users(12),
        },
        {
            id: "canceled",
            title: "Canceled",
            license: {
                valid: false,
                subscriptionStatus: "canceled",
                numberOfLicenses: 0,
            },
            usersWithAssignedLicense: [],
        },
        {
            // Billing never sets it (an ended trial becomes Free), but the
            // type still allows it.
            id: "expired",
            title: "Expired",
            license: {
                valid: false,
                subscriptionStatus: "expired",
                planType: "teams_managed",
                numberOfLicenses: 10,
                stripeCustomerId: "cus_test",
            },
            usersWithAssignedLicense: [],
        },
        {
            // An expiry with no Stripe customer behind it was a trial.
            id: "expired-trial",
            title: "Expired · was a trial",
            license: {
                valid: false,
                subscriptionStatus: "expired",
                numberOfLicenses: 0,
            },
            usersWithAssignedLicense: [],
        },
        {
            // Billing answered with no license at all: the trial was never
            // provisioned (e.g. an org seeded without onboarding).
            id: "no-license",
            title: "No license",
            license: { valid: false } as PlanFixture["license"],
            usersWithAssignedLicense: [],
        },
        {
            // The layout's fallback when billing didn't answer.
            id: "inactive",
            title: "Billing unreachable",
            license: {
                valid: false,
                subscriptionStatus: "inactive",
                numberOfLicenses: 0,
            },
            usersWithAssignedLicense: [],
        },
    ];
};
