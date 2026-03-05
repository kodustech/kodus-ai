import {
    FormattedConfigLevel,
    type FormattedCodeReviewConfig,
    type IFormattedConfigProperty,
} from "../code-review/_types";

function isFormattedConfigProperty(
    value: any,
): value is IFormattedConfigProperty<any> {
    return (
        value &&
        typeof value === "object" &&
        "value" in value &&
        "level" in value &&
        ("overriddenValue" in value || "overriddenLevel" in value)
    );
}

function countOverridesRecursive(
    obj: any,
    targetLevel: FormattedConfigLevel,
    path = "",
): number {
    if (!obj || typeof obj !== "object") {
        return 0;
    }

    if (isFormattedConfigProperty(obj)) {
        const propertyLevel = obj.level as FormattedConfigLevel;
        const overriddenLevel = obj.overriddenLevel as FormattedConfigLevel;

        const hasOverride =
            obj.overriddenValue !== undefined ||
            obj.overriddenLevel !== undefined;

        if (!hasOverride) {
            return 0;
        }

        const isGlobalOverridingDefault =
            propertyLevel === FormattedConfigLevel.GLOBAL &&
            overriddenLevel === FormattedConfigLevel.DEFAULT;

        if (isGlobalOverridingDefault) {
            return 0;
        }

        const isTargetLevel = propertyLevel === targetLevel;

        return isTargetLevel ? 1 : 0;
    }

    let count = 0;
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            count += countOverridesRecursive(
                obj[key],
                targetLevel,
                path ? `${path}.${key}` : key,
            );
        }
    }

    return count;
}

export function countConfigOverrides(
    config: FormattedCodeReviewConfig,
    level: FormattedConfigLevel = FormattedConfigLevel.GLOBAL,
): number {
    return countOverridesRecursive(config, level);
}
