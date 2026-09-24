"use client";

import { useSubscriptionStatus } from "./use-subscription-status";

/**
 * Plans whose resources the backend caps like Free.
 *
 * The API's `shouldLimitResources`
 * (libs/ee/shared/services/permissionValidation.service.ts) caps every
 * license the billing service calls invalid — not just `free_byok`. So an
 * org with no license row, or one whose subscription was canceled or
 * expired, really does have its rules paused past the cap and its plugins
 * skipped during reviews.
 *
 * The UI used to ask `status === "free"`, which left exactly those orgs
 * looking at rules marked "Paused" with no explanation and no way back —
 * the gate that should have appeared never did.
 *
 * `inactive` is deliberately not here: it is the layout's stand-in for
 * billing not answering, and a billing blip must not tell a paying customer
 * their rules are capped.
 */
const LIMITED_STATUSES = new Set([
    "free",
    "no-license",
    "canceled",
    "expired",
    "payment-failed",
]);

export const useIsResourceLimited = (): boolean => {
    const subscription = useSubscriptionStatus();
    return LIMITED_STATUSES.has(subscription.status);
};

/**
 * How to name the plan doing the capping, for gate copy. An org with no
 * license is on the free tier in everything but name; one that canceled or
 * lapsed is not, and saying "the Free plan" to them reads as a mistake.
 */
export const useCapOwnerLabel = (): string => {
    const subscription = useSubscriptionStatus();
    return subscription.status === "free" ||
        subscription.status === "no-license"
        ? "the Free plan"
        : "your current plan";
};
