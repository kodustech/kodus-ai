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

/**
 * Mirror of `normalizeModelId` in `libs/ee/ultra-review/ultra-merge-ranking.ts`
 * — keep aligned. The same model through two providers reads the same.
 */
export const normalizeUltraModel = (modelId: string): string => {
    let id = modelId.trim().toLowerCase();
    id = id.split("/").pop() ?? "";
    id = id.split("@")[0];
    id = id.replace(/^(?:(?:us|eu|apac|global)\.)?[a-z]+\.(?=[a-z])/, "");
    id = id.split(":")[0];
    id = id.replace(/-v\d+$/, "");
    id = id.replace(/(\d)p(\d)/g, "$1-$2");
    id = id.replace(/[._\s]+/g, "-");
    id = id.replace(/-(?:\d{8}|latest)$/, "");
    return id;
};

/**
 * Three different models picked, the only trio Ultra runs on. With
 * `modelOf` (id → provider model), two ids for the same model count once,
 * as the server does.
 */
export const isUltraTrioSet = (
    ids?: string[],
    modelOf?: (id: string) => string | undefined,
): boolean => {
    const picked = (ids ?? []).filter(Boolean);
    const keys = picked.map((id) => {
        const model = modelOf?.(id);
        return model ? normalizeUltraModel(model) : id;
    });
    return (
        picked.length === ULTRA_MODEL_COUNT &&
        new Set(keys).size === ULTRA_MODEL_COUNT
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
    modelOf?: (id: string) => string | undefined,
): string | undefined => {
    if (isUltraTrioSet(ids, modelOf)) return undefined;
    const picked = (ids ?? []).filter(Boolean);
    if (picked.length) return "Select three different models to save Ultra.";
    return required
        ? "Ultra is a review mode here. Keep three models, or change the mode first."
        : undefined;
};
