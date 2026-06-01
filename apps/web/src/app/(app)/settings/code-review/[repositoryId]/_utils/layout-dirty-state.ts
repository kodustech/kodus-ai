type DirtyFieldTree = Record<string, unknown>;

export function hasDirtyFieldsOutsidePromptOverrides(
    value: DirtyFieldTree,
    excludeKeys?: string[],
): boolean {
    for (const key of Object.keys(value)) {
        if (excludeKeys?.includes(key)) {
            continue;
        }

        const fieldValue = value[key];
        if (
            typeof fieldValue === "object" &&
            fieldValue !== null &&
            !Array.isArray(fieldValue)
        ) {
            if (
                hasDirtyFieldsOutsidePromptOverrides(
                    fieldValue as DirtyFieldTree,
                    excludeKeys,
                )
            ) {
                return true;
            }
            continue;
        }

        if (fieldValue === true) {
            return true;
        }
    }

    return false;
}

export function findFirstDirtyFieldOutsidePromptOverrides(
    value: DirtyFieldTree,
    prefix = "",
    excludeKeys?: string[],
): string | null {
    for (const key of Object.keys(value)) {
        if (excludeKeys?.includes(key)) {
            continue;
        }

        const path = prefix ? `${prefix}.${key}` : key;
        const fieldValue = value[key];

        if (
            typeof fieldValue === "object" &&
            fieldValue !== null &&
            !Array.isArray(fieldValue)
        ) {
            const found = findFirstDirtyFieldOutsidePromptOverrides(
                fieldValue as DirtyFieldTree,
                path,
                excludeKeys,
            );
            if (found) {
                return found;
            }
            continue;
        }

        if (fieldValue === true) {
            return path;
        }
    }

    return null;
}

export function shouldBlockCodeReviewLayoutNavigation({
    dirtyFields,
    formIsSubmitting,
}: {
    dirtyFields: DirtyFieldTree;
    formIsSubmitting: boolean;
}): boolean {
    return (
        hasDirtyFieldsOutsidePromptOverrides(dirtyFields, [
            "v2PromptOverrides",
        ]) || formIsSubmitting
    );
}
