/**
 * Reads the first-touch cookie written on *.kodus.io by the GTM tag in
 * `gtm-first-touch.html`. The web only passes it along with the request that
 * creates the organization; the API keeps the known fields and cleans them.
 */
export const FIRST_TOUCH_COOKIE = "kodus_first_touch";

export type FirstTouchPayload = Record<string, unknown>;

/**
 * Accepts the raw cookie value (URI-encoded JSON, as in `document.cookie`) or
 * an already decoded one (as Next's `cookies()` returns it). Anything that is
 * not a JSON object yields undefined, so a broken cookie never reaches, or
 * blocks, a signup.
 */
export const parseFirstTouchCookie = (
    value: string | null | undefined,
): FirstTouchPayload | undefined => {
    if (!value) return undefined;

    for (const candidate of [value, safeDecode(value)]) {
        if (!candidate) continue;
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
            ) {
                return parsed as FirstTouchPayload;
            }
        } catch {
            // try the next candidate
        }
    }

    return undefined;
};

export const readFirstTouchFromDocument = (): FirstTouchPayload | undefined => {
    if (typeof document === "undefined") return undefined;

    const prefix = `${FIRST_TOUCH_COOKIE}=`;
    const entry = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix));

    return parseFirstTouchCookie(entry?.slice(prefix.length));
};

const safeDecode = (value: string): string | undefined => {
    try {
        return decodeURIComponent(value);
    } catch {
        return undefined;
    }
};
