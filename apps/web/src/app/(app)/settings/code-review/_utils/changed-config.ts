/**
 * Which parts of the code-review form the user changed, so a save sends only
 * those. The form holds every setting of the scope, and some of them (the
 * Kody Rules page toggles) save on their own outside it; sending the whole
 * form would write their pre-toggle values back. The backend merges the
 * payload over what is stored, so a key left out keeps its stored value.
 */
export type ChangedConfigMask = { [key: string]: true | ChangedConfigMask };

type UnknownRecord = Record<string, unknown>;

const isPlainObject = (value: unknown): value is UnknownRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// A formatted property (`{ value, level, overriddenValue, ... }`) is one
// setting: its value goes to the backend as a whole, arrays included.
const isFormattedProperty = (value: unknown): value is UnknownRecord =>
    isPlainObject(value) && "value" in value;

const isDeepEqual = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;

    if (Array.isArray(a) && Array.isArray(b)) {
        return (
            a.length === b.length &&
            a.every((item, i) => isDeepEqual(item, b[i]))
        );
    }

    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        return [...keys].every((key) => isDeepEqual(a[key], b[key]));
    }

    return false;
};

/**
 * Compares the formatted form values with the form's defaults (the last
 * loaded or saved state). A formatted property counts as changed when its
 * value or level differs; a reverted override changes the level.
 */
export const getChangedConfigMask = (
    current: unknown,
    baseline: unknown,
): ChangedConfigMask => {
    const mask: ChangedConfigMask = {};
    if (!isPlainObject(current)) return mask;

    const baselineRecord = isPlainObject(baseline) ? baseline : {};

    Object.entries(current).forEach(([key, node]) => {
        const baselineNode = baselineRecord[key];

        if (isFormattedProperty(node)) {
            const baselineProperty = isFormattedProperty(baselineNode)
                ? baselineNode
                : undefined;

            if (
                !isDeepEqual(node.value, baselineProperty?.value) ||
                !isDeepEqual(node.level, baselineProperty?.level)
            ) {
                mask[key] = true;
            }
            return;
        }

        if (isPlainObject(node)) {
            const nested = getChangedConfigMask(node, baselineNode);
            if (Object.keys(nested).length > 0) mask[key] = nested;
            return;
        }

        if (!isDeepEqual(node, baselineNode)) mask[key] = true;
    });

    return mask;
};

/** Keeps only the masked keys of an unformatted save payload. */
export const pickChangedConfig = <T extends object>(
    payload: T,
    mask: ChangedConfigMask,
): Partial<T> => {
    const picked: UnknownRecord = {};
    const source = payload as UnknownRecord;

    Object.entries(mask).forEach(([key, entry]) => {
        if (!(key in source)) return;

        const value = source[key];

        if (entry === true) {
            picked[key] = value;
            return;
        }

        if (!isPlainObject(value)) return;

        const nested = pickChangedConfig(value, entry);
        if (Object.keys(nested).length > 0) picked[key] = nested;
    });

    return picked as Partial<T>;
};
