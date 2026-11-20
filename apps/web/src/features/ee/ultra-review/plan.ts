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
    // A Bedrock version (`-v1:0`) goes; a `-v4` that names the model stays.
    id = id.replace(/-v\d+:.*$/, "");
    id = id.split(":")[0];
    id = id.replace(/(\d)p(\d)/g, "$1-$2");
    id = id.replace(/[._\s]+/g, "-");
    // A release date, `-20261101` or `-2026-11-01`. Not `-MMDD`: that
    // names a distinct release (Kimi K2 0711 and 0905).
    id = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "");
    return id;
};

/**
 * id → provider model for `isUltraTrioSet`, from status models (`modelId`,
 * the routing key) or config models (`id`), indexed once.
 */
export const ultraModelResolver = (
    models:
        | ReadonlyArray<{ id?: string; modelId?: string; model?: string }>
        | undefined,
): ((id: string) => string | undefined) => {
    const byId = new Map(
        (models ?? []).map((m) => [m.modelId ?? m.id, m.model] as const),
    );
    return (id) => byId.get(id);
};

/**
 * id → whether Ultra can run that model, as the server checks on save: one of
 * the organization's own models whose provider still connects.
 */
export const ultraModelUsable = (
    models:
        | ReadonlyArray<{
              id?: string;
              modelId?: string;
              resolvable?: boolean;
              managed?: boolean;
          }>
        | undefined,
): ((id: string) => boolean) => {
    const usable = new Set(
        (models ?? [])
            .filter((m) => m.resolvable !== false && !m.managed)
            .map((m) => m.modelId ?? m.id),
    );
    return (id) => usable.has(id);
};

/**
 * Three different models picked, the only trio Ultra runs on. With
 * `modelOf` (id → provider model), two ids for the same model count once,
 * as the server does; with `usable`, a model that can no longer run leaves
 * the trio unset.
 */
export const isUltraTrioSet = (
    ids?: string[],
    modelOf?: (id: string) => string | undefined,
    usable?: (id: string) => boolean,
): boolean => {
    const picked = (ids ?? []).filter(Boolean);
    if (usable && !picked.every(usable)) return false;
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
    usable?: (id: string) => boolean,
): string | undefined => {
    if (isUltraTrioSet(ids, modelOf, usable)) return undefined;
    const picked = (ids ?? []).filter(Boolean);
    if (usable && !picked.every(usable)) {
        return "A model picked for Ultra can no longer run. Reconnect its provider or pick another.";
    }
    if (picked.length) return "Select three different models to save Ultra.";
    return required
        ? "Ultra is a review mode here. Keep three models, or change the mode first."
        : undefined;
};
