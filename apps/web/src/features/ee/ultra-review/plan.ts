import { isTeamsOrEnterprisePlan } from "src/features/ee/byok/_utils";
import type { OrganizationLicense } from "src/features/ee/subscription/_services/billing/types";

/** Ultra runs on exactly three models. */
export const ULTRA_MODEL_COUNT = 3;

/**
 * Mirror of `isUltraReviewTierAllowed` in
 * `libs/ee/ultra-review/ultra-review-plan.ts` — keep aligned. The plans that
 * run heavy; the three models being the team's own is what keeps a trial on
 * Kodus's keys, and free, out.
 */
export const isUltraReviewPlan = (
    license: OrganizationLicense | null | undefined,
): boolean =>
    isTeamsOrEnterprisePlan(license, {
        selfHostedTiers: ["teams", "enterprise"],
    });

/** Three different models picked, the only trio Ultra runs on. */
export const isUltraTrioSet = (ids?: string[]): boolean => {
    const picked = (ids ?? []).filter(Boolean);
    return (
        picked.length === ULTRA_MODEL_COUNT &&
        new Set(picked).size === ULTRA_MODEL_COUNT
    );
};

/**
 * What blocks saving the trio, or nothing: none picked, or three different.
 * While a review mode here is Ultra (`required`), none picked blocks too: the
 * reviews would stop.
 */
export const ultraTrioError = (
    ids?: string[],
    required = false,
): string | undefined => {
    if (isUltraTrioSet(ids)) return undefined;
    const picked = (ids ?? []).filter(Boolean);
    if (picked.length) return "Select three different models to save Ultra.";
    return required
        ? "Ultra is a review mode here. Keep three models, or change the mode first."
        : undefined;
};
