import { isOverrideValueChanged } from "../_components/override-state";

const fields = [
    "riskAssessmentActive",
    "riskCriteria",
    "approvalPolicies",
    "reviewMode",
    "riskReviewRouting.noRisk",
    "riskReviewRouting.riskFound",
];
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const at = (value: unknown, path: string): unknown =>
    path
        .split(".")
        .reduce<unknown>(
            (node, key) => (record(node) ? node[key] : undefined),
            value,
        );

export const isReviewSettingsInheritanceField = (field: string) =>
    fields.includes(field);

export function getInheritedReviewFields(
    current: unknown,
    baseline: unknown,
    level: string,
): string[] {
    if (level === "global") return [];
    return fields.filter((field) => {
        const before = at(baseline, field);
        const after = at(current, field);
        if (
            !record(after) ||
            !("value" in after) ||
            typeof after.level !== "string" ||
            after.level === level
        )
            return false;
        if (
            record(before) &&
            before.level === after.level &&
            !isOverrideValueChanged(before.value, after.value)
        )
            return false;
        // Undo records its actual intent even while the server's ownership
        // metadata is still being refreshed after a successful save.
        const intent = after.inheritanceIntent;
        if (
            record(intent) &&
            intent.level === after.level &&
            !isOverrideValueChanged(after.value, intent.value)
        )
            return true;
        return (
            record(before) &&
            before.level === level &&
            !isOverrideValueChanged(after.value, before.overriddenValue)
        );
    });
}

/** Transient Undo state is consumed by one successful save, never cached. */
export function withoutReviewInheritanceIntents<T extends object>(value: T): T {
    const next = Object.fromEntries<unknown>(Object.entries(value));
    for (const field of fields) {
        const node = at(next, field);
        if (!record(node) || !("inheritanceIntent" in node)) continue;
        const clean = { ...node };
        delete clean.inheritanceIntent;
        const [key, leaf] = field.split(".");
        const parent = next[key];
        if (leaf)
            next[key] = { ...(record(parent) ? parent : {}), [leaf]: clean };
        else next[key] = clean;
    }
    return next as T;
}
