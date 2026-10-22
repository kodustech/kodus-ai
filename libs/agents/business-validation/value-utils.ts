export function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') {
        return {};
    }
    return value as Record<string, unknown>;
}

export function safeJsonParse<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

export function safeStringify(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value;
    }

    if (value && typeof value === 'object') {
        try {
            const json = JSON.stringify(value);
            return json.length > 2 ? json : undefined;
        } catch {
            return undefined;
        }
    }

    return undefined;
}

/** No answer at all: nothing, a blank string, an empty object or list. */
export function isEmpty(value: unknown): boolean {
    if (value === undefined || value === null) {
        return true;
    }
    if (typeof value === 'string') {
        return !value.trim();
    }
    if (Array.isArray(value)) {
        return value.length === 0;
    }
    return typeof value === 'object' && Object.keys(value).length === 0;
}
