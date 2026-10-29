/**
 * First-touch marketing attribution of the user who created an organization.
 *
 * Captured in the browser by the GTM tag in
 * `apps/web/src/lib/attribution/gtm-first-touch.html` (cookie
 * `kodus_first_touch` on `.kodus.io`), sent by the web with the request
 * that creates the organization, and written once, in the same insert. The
 * cookie is client-controlled, so everything goes through `sanitizeFirstTouch`
 * before it is stored.
 */
export interface FirstTouch {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
    gclid?: string;
    /** Origin + path of the referring page, no query or fragment. */
    referrer?: string;
    /** Landing page, keeping only the campaign parameters above. */
    landing_page?: string;
    /** ISO timestamp of the first visit, from the browser clock. */
    captured_at?: string;
}

export const FIRST_TOUCH_CAMPAIGN_PARAMS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'gclid',
] as const;

export const FIRST_TOUCH_TEXT_MAX = 200;
export const FIRST_TOUCH_URL_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// Browser clocks drift; anything further ahead than this is not a real visit.
const MAX_CLOCK_SKEW_MS = DAY_MS;
// The cookie lives one year; older than this is not a real visit either.
const MAX_AGE_MS = 2 * 365 * DAY_MS;

// eslint-disable-next-line no-control-regex -- intentional: strip control characters from client input
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const GCLID = /^[a-z0-9_-]+$/i;

/**
 * Keeps only the known keys, as trimmed strings, truncated, with anything that
 * could identify a person dropped (email-like values, URL query strings,
 * fragments and credentials). Never throws: a malformed value is dropped
 * rather than failing the signup that carries it. Returns null when nothing
 * survives.
 */
export function sanitizeFirstTouch(
    input: unknown,
    now: Date = new Date(),
): FirstTouch | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null;
    }

    const raw = input as Record<string, unknown>;
    const result: FirstTouch = {};

    for (const key of FIRST_TOUCH_CAMPAIGN_PARAMS) {
        const value = sanitizeCampaignValue(key, raw[key]);
        if (value) {
            result[key] = value;
        }
    }

    const referrer = sanitizeUrl(raw.referrer, false);
    if (referrer) {
        result.referrer = referrer;
    }

    const landingPage = sanitizeUrl(raw.landing_page, true);
    if (landingPage) {
        result.landing_page = landingPage;
    }

    const capturedAt = sanitizeTimestamp(raw.captured_at, now);
    if (capturedAt) {
        result.captured_at = capturedAt;
    }

    return Object.keys(result).length > 0 ? result : null;
}

function sanitizeCampaignValue(key: string, value: unknown): string | null {
    const text = sanitizeText(value);
    if (!text) {
        return null;
    }

    if (key === 'gclid' && !GCLID.test(text)) {
        return null;
    }

    return text.slice(0, FIRST_TOUCH_TEXT_MAX);
}

function sanitizeText(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const text = value.replace(CONTROL_CHARS, '').trim();
    if (!text || EMAIL.test(text)) {
        return null;
    }

    return text;
}

/**
 * http(s) URLs only, reduced to origin + path. The landing page keeps the
 * campaign parameters (cleaned like the fields above); the referrer keeps no
 * query at all.
 */
function sanitizeUrl(
    value: unknown,
    keepCampaignParams: boolean,
): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    let url: URL;
    try {
        url = new URL(value.replace(CONTROL_CHARS, '').trim());
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }

    let path: string;
    try {
        path = decodeURIComponent(url.pathname);
    } catch {
        path = url.pathname;
    }
    if (EMAIL.test(path)) {
        return null;
    }

    const query = new URLSearchParams();
    if (keepCampaignParams) {
        for (const key of FIRST_TOUCH_CAMPAIGN_PARAMS) {
            const param = sanitizeCampaignValue(key, url.searchParams.get(key));
            if (param) {
                query.set(key, param);
            }
        }
    }

    const search = query.toString();
    const clean = `${url.origin}${url.pathname}${search ? `?${search}` : ''}`;

    return clean.slice(0, FIRST_TOUCH_URL_MAX);
}

function sanitizeTimestamp(value: unknown, now: Date): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const date = new Date(value);
    const time = date.getTime();
    if (
        Number.isNaN(time) ||
        time > now.getTime() + MAX_CLOCK_SKEW_MS ||
        time < now.getTime() - MAX_AGE_MS
    ) {
        return null;
    }

    return date.toISOString();
}
