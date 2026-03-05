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
