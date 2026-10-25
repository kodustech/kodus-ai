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

/** What an empty answer carries beside its empty list: a message, a status, a count. */
const ENVELOPE_KEY =
    /^(?:message|error|errors|detail|details|status|status_?code|code|total|count|has_?more|next_?cursor|cursor|page|ok|success)$/i;
const MAX_ENVELOPE_TEXT = 200;

/**
 * An answer with nothing in it: empty, or only empty lists beside a short
 * message, status or count (`{"tasks":[]}`, `{"message":"No results"}`).
 * Plain text is not one: it may be a task in a shape nobody parsed; nor is a
 * failure (`{"error":"Unauthorized"}`, `{"tasks":[],"status":500}`), which
 * says nothing about whether the task exists.
 */
export function answersNothing(value: unknown): boolean {
    if (isEmpty(value)) {
        return true;
    }
    if (typeof value === 'string') {
        const parsed = safeJsonParse<unknown>(value, undefined);
        return typeof parsed === 'object' && parsed !== null
            ? answersNothing(parsed)
            : false;
    }
    if (Array.isArray(value)) {
        return value.every(answersNothing);
    }
    if (typeof value !== 'object' || reportsFailure(value)) {
        return false;
    }
    return Object.entries(value).every(
        ([key, field]) =>
            answersNothing(field) ||
            (ENVELOPE_KEY.test(key) &&
                (field === null || typeof field !== 'object') &&
                String(field).length <= MAX_ENVELOPE_TEXT),
    );
}

const FAILED_STATUS = /^(?:error|failed|failure|unauthori[sz]ed|forbidden)$/i;

/** An envelope that says the call failed: an error, `ok: false`, a 4xx/5xx status. */
function reportsFailure(envelope: object): boolean {
    return Object.entries(envelope).some(([key, field]) => {
        const name = key.toLowerCase().replace('_', '');
        if (name === 'error' || name === 'errors') {
            return !isEmpty(field) && field !== false;
        }
        if (name === 'ok' || name === 'success') {
            return field === false;
        }
        if (name === 'status' || name === 'statuscode' || name === 'code') {
            const code = Number(field);
            return (
                (Number.isInteger(code) && code >= 400 && code < 600) ||
                (typeof field === 'string' && FAILED_STATUS.test(field))
            );
        }
        return false;
    });
}
