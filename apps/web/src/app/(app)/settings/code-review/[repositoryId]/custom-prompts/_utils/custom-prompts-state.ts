import { convertTiptapJSONToText } from "../../../../../../../core/utils/tiptap-json-to-text";

const setValueAtPath = (
    source: unknown,
    path: string,
    value: unknown,
): unknown => {
    const segments = path.split(".");

    const update = (current: unknown, index: number): unknown => {
        const key = segments[index];
        const isLeaf = index === segments.length - 1;
        const currentObject =
            typeof current === "object" && current !== null
                ? (current as Record<string, unknown>)
                : {};

        if (isLeaf) {
            return {
                ...currentObject,
                [key]: value,
            };
        }

        return {
            ...currentObject,
            [key]: update(currentObject[key], index + 1),
        };
    };

    return update(source, 0);
};

export const getValueAtPath = (source: unknown, path: string) =>
    path
        .split(".")
        .reduce<unknown>(
            (current, key) =>
                typeof current === "object" && current !== null
                    ? (current as Record<string, unknown>)[key]
                    : undefined,
            source,
        );

export const PROMPT_FIELD_PATHS = [
    "v2PromptOverrides.generation.main.value",
    "v2PromptOverrides.categories.descriptions.bug.value",
    "v2PromptOverrides.categories.descriptions.performance.value",
    "v2PromptOverrides.categories.descriptions.security.value",
    "v2PromptOverrides.severity.flags.critical.value",
    "v2PromptOverrides.severity.flags.high.value",
    "v2PromptOverrides.severity.flags.medium.value",
    "v2PromptOverrides.severity.flags.low.value",
] as const;

export function parsePromptFieldValue(value: unknown): string | object {
    if (
        typeof value === "string" &&
        value.startsWith("{") &&
        value.trim().startsWith("{")
    ) {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    if (typeof value === "object" && value !== null) {
        return value;
    }

    return String(value ?? "");
}

export function serializePromptFieldValue(value: string | object): string {
    if (typeof value === "object" && value !== null) {
        return JSON.stringify(value);
    }

    return value || "";
}

export function getPromptFieldText(value: unknown): string {
    return (
        convertTiptapJSONToText(
            value as string | object | null | undefined,
        )?.trim() ?? ""
    );
}

export function buildPromptInitialTextMap(
    promptFields: string[],
    currentValues: unknown,
    defaults: unknown,
): Record<string, string> {
    return Object.fromEntries(
        promptFields.map((fieldPath) => {
            const savedValue = getValueAtPath(currentValues, fieldPath);
            const savedText = getPromptFieldText(savedValue);

            if (savedText) {
                return [fieldPath, savedText];
            }

            const defaultPath = fieldPath
                .replace("v2PromptOverrides.", "")
                .replace(".value", "");

            return [
                fieldPath,
                getPromptFieldText(getValueAtPath(defaults, defaultPath)),
            ];
        }),
    );
}

export function normalizePromptFormValues<T>(
    formValues: T,
    defaults: unknown,
    promptFields: readonly string[] = PROMPT_FIELD_PATHS,
): T {
    let nextValues = formValues;

    promptFields.forEach((fieldPath) => {
        const currentValue = getValueAtPath(nextValues, fieldPath);

        if (getPromptFieldText(currentValue)) {
            return;
        }

        const defaultPath = fieldPath
            .replace("v2PromptOverrides.", "")
            .replace(".value", "");
        const defaultValue = getPromptFieldText(
            getValueAtPath(defaults, defaultPath),
        );

        if (!defaultValue) {
            return;
        }

        nextValues = setValueAtPath(nextValues, fieldPath, defaultValue) as T;
    });

    return nextValues;
}
