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
/** A cut click id no longer identifies the click: kept whole or dropped. */
export const FIRST_TOUCH_GCLID_MAX = 255;
export const FIRST_TOUCH_URL_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
// Browser clocks drift; anything further ahead than this is not a real visit.
const MAX_CLOCK_SKEW_MS = DAY_MS;
// The cookie lives one year (by that same clock); older is not a real visit
// either.
const MAX_AGE_MS = 365 * DAY_MS + MAX_CLOCK_SKEW_MS;
// The body is client-controlled and the endpoint is public: bound every value
// before scanning it. Text keeps room past the cut for an email that starts
// before it (254 = longest valid address); the tag never writes longer URLs.
const TEXT_SCAN_MAX = FIRST_TOUCH_TEXT_MAX + 254;
const URL_INPUT_MAX = 2048;

// Controls, format characters and anything else that renders as nothing:
// 'goo\u200bgle' would count as a source of its own, and Postgres rejects
// \u0000 in jsonb.
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// Half of a surrogate pair: Postgres rejects it in jsonb, failing the insert
// of the organization. Comes from a cut through an emoji or straight from JSON.
const LONE_SURROGATE =
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ENCODED_AT = /%40/gi;
const EMAIL_LOCAL_CHAR = /[a-z0-9._%+-]/i;
const EMAIL_DOMAIN = /[a-z0-9.-]+/iy;
const EMAIL_TLD = /\.[a-z]{2,}/i;
// A UTF-8 lead byte at the end with fewer continuation bytes than it needs.
const PARTIAL_CHARACTER =
    /(?:%[cd][0-9a-f]|%e[0-9a-f](?:%[89ab][0-9a-f])?|%f[0-7](?:%[89ab][0-9a-f]){0,2})$/i;
const GCLID = /^[a-z0-9_-]+$/i;

/**
 * Keeps only the known keys, as trimmed strings, truncated, with anything that
 * could identify a person dropped (campaign values with an '@', paths with an
 * email, URL query strings, fragments and credentials). Never throws: a
 * malformed value is dropped rather than failing the signup that carries it.
 * Returns null when nothing survives.
 */
export function sanitizeFirstTouch(
    input: unknown,
    now: Date = new Date(),
): FirstTouch | null {
    // Attribution must never cost a signup, whatever reaches this point.
    try {
        return sanitize(input, now);
    } catch {
        return null;
    }
}

function sanitize(input: unknown, now: Date): FirstTouch | null {
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
    if (key === 'gclid') {
        return typeof value === 'string' &&
            value.length <= FIRST_TOUCH_GCLID_MAX &&
            GCLID.test(value)
            ? value
            : null;
    }

    return sanitizeText(value);
}

function sanitizeText(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const text = value
        .slice(0, TEXT_SCAN_MAX)
        .replace(INVISIBLE_CHARS, '')
        .replace(LONE_SURROGATE, '')
        .trim();
    // A campaign value has no business carrying an '@'.
    if (!text || withAtSigns(text).includes('@')) {
        return null;
    }

    return text.slice(0, FIRST_TOUCH_TEXT_MAX).replace(LONE_SURROGATE, '');
}

/**
 * The value decoded once, with an '@' still encoded read as one. That covers
 * the real case, a newsletter link carrying the reader's address, also when a
 * click tracker encoded it twice. Getting past it (deeper encoding, lookalike
 * or invisible characters) only stores someone's own address on their own
 * organization.
 */
function withAtSigns(value: string): string {
    let text: string;
    try {
        text = decodeURIComponent(value);
    } catch {
        text = value;
    }
    return text.replace(ENCODED_AT, '@');
}

/**
 * Whether the path has something shaped like local@domain.tld: a path can
 * hold a handle (medium.com/@jane), so an '@' alone does not drop it. Linear
 * on purpose: the equivalent single regex backtracks quadratically on long
 * inputs.
 */
function containsEmail(path: string): boolean {
    const text = withAtSigns(path);
    for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
        if (at === 0 || !EMAIL_LOCAL_CHAR.test(text[at - 1])) {
            continue;
        }
        EMAIL_DOMAIN.lastIndex = at + 1;
        const domain = EMAIL_DOMAIN.exec(text)?.[0];
        if (domain && EMAIL_TLD.test(domain)) {
            return true;
        }
    }
    return false;
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
    if (typeof value !== 'string' || value.length > URL_INPUT_MAX) {
        return null;
    }

    let url: URL;
    try {
        url = new URL(value.replace(INVISIBLE_CHARS, '').trim());
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }

    if (containsEmail(url.pathname)) {
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

    // Cut the path, never the query, so the landing page's campaign values
    // match the fields. Without room for the query, the fields carry them.
    const search = query.toString();
    const suffix = search ? `?${search}` : '';
    const room = FIRST_TOUCH_URL_MAX - url.origin.length - suffix.length;
    if (room < 1) {
        return cutUrl(`${url.origin}${url.pathname}`, FIRST_TOUCH_URL_MAX);
    }

    return `${url.origin}${cutUrl(url.pathname, room)}${suffix}`;
}

/**
 * Cut without leaving half a %XX escape at the end, nor part of a character
 * encoded in several: '/%E2%9C%93' cut to '/%E2%9C' no longer decodes.
 */
function cutUrl(url: string, max: number): string {
    return url
        .slice(0, max)
        .replace(/%[0-9a-f]?$/i, '')
        .replace(PARTIAL_CHARACTER, '');
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
