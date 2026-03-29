import { FormattedConfigLevel, type IFormattedConfigProperty } from "../_types";

export const isOverrideValueChanged = (
    currentValue: unknown,
    parentValue: unknown,
) => {
    if (Array.isArray(currentValue) && Array.isArray(parentValue)) {
        return JSON.stringify(currentValue) !== JSON.stringify(parentValue);
    }

    if (
        typeof currentValue === "object" &&
        typeof parentValue === "object" &&
        currentValue !== null &&
        parentValue !== null
    ) {
        return JSON.stringify(currentValue) !== JSON.stringify(parentValue);
    }

    return currentValue !== parentValue;
};

export const buildOverrideRevertState = <T>(
    initialState: IFormattedConfigProperty<T>,
    currentLevel: FormattedConfigLevel,
) => {
    const isExistingOverride = initialState.level === currentLevel;

    return {
        value: isExistingOverride
            ? initialState.overriddenValue
            : initialState.value,
        level:
            (isExistingOverride
                ? initialState.overriddenLevel
                : initialState.level) ?? FormattedConfigLevel.DEFAULT,
    };
};
