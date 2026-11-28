import { createHash, type KeyObject, randomBytes, sign, verify } from 'crypto';

import { nulJoinedDigest } from './derive-id';
import { z } from 'zod';

import { SealedTokenSchema } from '@libs/runtime/contracts/boundary-values';

// Preview URLs (docs/runtime/preview-urls.md): a person opens, in a browser,
// one side of a finished Run, booted again on its own claim (consumer
// preview). The API checks access and mints a single-use grant; the preview
// edge exchanges it for a host-only cookie and proxies the browser's requests
// over the tunnel the cell dialed; the cell serves only the routes the hub
// declared. Shared here so the API (grant), the worker (records), the hub
// (routes) and the edge (session, headers) read the same rules.

export const PREVIEW_SIDES = ['base', 'pr'] as const;
export type PreviewSide = (typeof PREVIEW_SIDES)[number];
export const PreviewSideSchema = z.enum(PREVIEW_SIDES);

/**
 * A preview's life (§5.2). starting: a claim is booting; ready: routed and
 * served; sleeping: no claim (idle or past its ceiling), the next request
 * wakes it; blocked: it could not boot (capacity, setup); stopped: someone
 * stopped it, or a security event; expired: its record ended (7 days, PR
 * closed, a newer Run).
 */
export const PREVIEW_STATES = ['starting', 'ready', 'sleeping', 'blocked', 'stopped', 'expired'] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];
/** A preview a viewer may still reach: the edge serves it or wakes it. */
export const isOpenPreviewState = (s: string): boolean => s === 'starting' || s === 'ready' || s === 'sleeping' || s === 'blocked';

/** Lifecycle (decision 3): idle stop, one start's ceiling, how long the record lives. */
export const PREVIEW_IDLE_MINUTES = 15;
export const PREVIEW_CEILING_MINUTES = 120;
export const PREVIEW_RECORD_DAYS = 7;
/** The edge reports a preview's traffic at most this often; the worker renews the lease on it. */
export const PREVIEW_ACTIVITY_EVERY_MS = 60_000;

/** Per-preview limits at the edge and the cell (§4.2). */
export const PREVIEW_LIMITS = {
    concurrentStreams: 64,
    requestBodyBytes: 32 * 1024 * 1024,
    requestTimeoutMs: 5 * 60_000,
} as const;

// ids and hosts

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Buffer, length: number): string {
    let out = '';
    let bits = 0;
    let value = 0;
    for (const b of bytes) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5 && out.length < length) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (out.length < length) throw new Error('not enough bytes for the id');
    return out;
}

export const PREVIEW_ID_PATTERN = /^prv_[a-z2-7]{26}$/;
export const PreviewIdSchema = z.string().regex(PREVIEW_ID_PATTERN);

/**
 * The preview of one side of one Run: the same id for every open, so two
 * clicks at once open one preview. It names nothing (a hash), and the org is
 * in it, like claimIdFor.
 */
export function previewIdFor(organizationId: string, runId: string, side: PreviewSide): string {
    const digest = nulJoinedDigest(['kody-runtime/preview/v1', organizationId, runId, side]);
    return `prv_${base32(digest, 26)}`;
}

/**
 * The preview of an environment (§5.1, §8.3): its base side at the commit
 * its last setup baked, with no Run. A new bake is a new preview; opening it
 * ends the older one.
 */
export function environmentPreviewIdFor(organizationId: string, environmentId: string, sha: string): string {
    const digest = nulJoinedDigest(['kody-runtime/preview/environment/v1', organizationId, environmentId, sha]);
    return `prv_${base32(digest, 26)}`;
}

/** The token a preview's claim downloads its code with is sealed to this binding (like envSessionTokenBinding). */
export const previewTokenBinding = (previewId: string) => `preview:${previewId}`;

/** One host label per preview and side (§6.2): random, so the host names no org, repository or PR. */
export const PREVIEW_HOST_LABEL = /^p-[a-z2-7]{26}-(pr|base)$/;
export function newPreviewHostLabel(side: PreviewSide, random: (n: number) => Buffer = randomBytes): string {
    return `p-${base32(random(17), 26)}-${side}`;
}

/** The preview domain as configured: lowercase DNS name, at least two labels, no scheme, port or wildcard. */
export const PreviewDomainSchema = z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);

export const previewHost = (label: string, domain: string) => `${label}.${domain}`;

/**
 * The preview host label of a request's Host, or null: exactly one label
 * matching the scheme directly under the domain, no port beyond the edge's
 * own, nothing else. A wrong host and an unknown one get the same 404.
 */
export function previewLabelOf(hostHeader: string | undefined, domain: string): string | null {
    if (!hostHeader) return null;
    const host = hostHeader.toLowerCase().replace(/:\d{1,5}$/, '');
    const suffix = `.${domain}`;
    if (!host.endsWith(suffix)) return null;
    const label = host.slice(0, -suffix.length);
    return PREVIEW_HOST_LABEL.test(label) ? label : null;
}

/**
 * The registrable domain (eTLD+1) a host is under, by a deliberately small
 * rule: the last two labels, or three when the second-level label is a
 * known public second level (co.uk, com.br…). The edge refuses a preview
 * domain of the same site as the web app (§4.4) by this.
 */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);
export function registrableDomainOf(host: string): string {
    const labels = host.toLowerCase().replace(/\.$/, '').split('.');
    if (labels.length <= 2) return labels.join('.');
    const take = SECOND_LEVEL.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
    return labels.slice(-take).join('.');
}
export function isSameSite(previewDomain: string, appHost: string): boolean {
    return registrableDomainOf(previewDomain) === registrableDomainOf(appHost);
}

// the grant (§6.4)

/**
 * A grant: a JWS (EdDSA, RFC 8037) the API signs and the edge verifies with
 * the public key. Explicitly typed (RFC 8725 §3.11) so no other JWT of Kodus
 * passes for it, audience the preview host (§3.9), 60 s, single use by jti.
 */
export const PREVIEW_GRANT_TYP = 'kodus-preview-grant+jwt';
export const PREVIEW_GRANT_TTL_SECONDS = 60;
export const PREVIEW_GRANT_ISSUER = 'kodus';

export const PreviewGrantClaimsSchema = z.strictObject({
    iss: z.literal(PREVIEW_GRANT_ISSUER),
    aud: z.string().min(1).max(253),
    sub: z.string().min(1).max(128),
    org: z.string().min(1).max(128),
    pid: PreviewIdSchema,
    side: PreviewSideSchema,
    jti: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
    iat: z.number().int(),
    exp: z.number().int(),
});
export type PreviewGrantClaims = z.infer<typeof PreviewGrantClaimsSchema>;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signPreviewGrant(
    privateKey: KeyObject,
    input: { host: string; userId: string; organizationId: string; previewId: string; side: PreviewSide; now: number; jti?: string },
): { token: string; claims: PreviewGrantClaims } {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the preview grant key must be Ed25519');
    const iat = Math.floor(input.now / 1000);
    const claims = PreviewGrantClaimsSchema.parse({
        iss: PREVIEW_GRANT_ISSUER,
        aud: input.host,
        sub: input.userId,
        org: input.organizationId,
        pid: input.previewId,
        side: input.side,
        jti: input.jti ?? randomBytes(18).toString('base64url'),
        iat,
        exp: iat + PREVIEW_GRANT_TTL_SECONDS,
    });
    const signingInput = `${b64url(JSON.stringify({ alg: 'EdDSA', typ: PREVIEW_GRANT_TYP }))}.${b64url(JSON.stringify(claims))}`;
    const signature = sign(null, Buffer.from(signingInput), privateKey);
    return { token: `${signingInput}.${b64url(signature)}`, claims };
}

export type PreviewGrantRefusal = 'malformed' | 'bad_signature' | 'wrong_type' | 'wrong_audience' | 'expired' | 'not_yet_valid';

/**
 * The grant's claims if it is ours, for this host, and inside its 60 s
 * (with 5 s of clock skew); else why not. Single use is the edge's (it
 * stores the jti until exp).
 */
export function verifyPreviewGrant(
    publicKey: KeyObject,
    token: string,
    expect: { host: string; now: number },
): { ok: true; claims: PreviewGrantClaims } | { ok: false; reason: PreviewGrantRefusal } {
    if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
    let header: unknown;
    let payload: unknown;
    try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    // The algorithm is the key's, never the header's choice (RFC 8725 §3.1).
    const h = header as { alg?: unknown; typ?: unknown };
    if (!h || typeof h !== 'object' || h.alg !== 'EdDSA' || Object.keys(h).some((k) => k !== 'alg' && k !== 'typ')) return { ok: false, reason: 'malformed' };
    if (publicKey.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'bad_signature' };
    const valid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
    if (!valid) return { ok: false, reason: 'bad_signature' };
    if (h.typ !== PREVIEW_GRANT_TYP) return { ok: false, reason: 'wrong_type' };
    const claims = PreviewGrantClaimsSchema.safeParse(payload);
    if (!claims.success || claims.data.exp - claims.data.iat > PREVIEW_GRANT_TTL_SECONDS) return { ok: false, reason: 'malformed' };
    if (claims.data.aud !== expect.host.toLowerCase()) return { ok: false, reason: 'wrong_audience' };
    const now = Math.floor(expect.now / 1000);
    if (claims.data.iat > now + 5) return { ok: false, reason: 'not_yet_valid' };
    if (now >= claims.data.exp) return { ok: false, reason: 'expired' };
    return { ok: true, claims: claims.data };
}

// the session cookie and headers (§6.4)

/** Host-only, so a sibling preview never receives it (RFC 6265bis `__Host-`: Secure, Path=/, no Domain). */
export const PREVIEW_COOKIE = '__Host-kodus_preview';
export const PREVIEW_SESSION_MAX_HOURS = 12;
/**
 * A session older than this is not served: the viewer goes back through the
 * app for a fresh grant, so a member removed from the org or the repository
 * loses an open preview within this many minutes (review 2026-11-14, #9).
 * The renewal skips the prompt when the browser holds this viewer's session.
 */
export const PREVIEW_SESSION_REVALIDATE_MINUTES = 15;
/** Reserved on every preview host: the edge's own pages; an app path under it is not reachable. */
export const PREVIEW_RESERVED_PREFIX = '/__kodus/';

export function previewSessionCookie(value: string, maxAgeSeconds: number): string {
    return `${PREVIEW_COOKIE}=${value}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** The edge's session id from a Cookie header, or undefined. */
export function previewSessionOf(cookieHeader: string | undefined): string | undefined {
    for (const part of (cookieHeader ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq).trim() === PREVIEW_COOKIE) {
            const v = part.slice(eq + 1).trim();
            return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : undefined;
        }
    }
    return undefined;
}

/**
 * A Cookie header longer than this is answered by the edge itself, never
 * proxied: until the preview domain is on the Public Suffix List, a page of
 * any preview can set cookies on the whole domain (document.cookie with
 * Domain=), and a few of 4 KB push every later request of that browser, on
 * every org's previews, past what a server accepts (S1-WEB-01).
 */
export const PREVIEW_COOKIE_HEADER_MAX = 8 * 1024;

/** One preview and side, whatever its expose: `p-<id>-pr` and `p-<id>-pr-2` are one. */
const PREVIEW_EXPOSE_LABEL = /^(p-[a-z2-7]{26}-(?:pr|base))(?:-[2-9])?$/;
const previewOf = (host: string, domain: string): string | undefined => {
    const suffix = `.${domain.toLowerCase()}`;
    const h = host.toLowerCase().replace(/:\d{1,5}$/, '');
    return h.endsWith(suffix) ? PREVIEW_EXPOSE_LABEL.exec(h.slice(0, -suffix.length))?.[1] : undefined;
};

/** The host a request came from, as the browser says it (Origin, else Referer): no page can set either. */
function requestOriginHost(headers: Record<string, string | string[] | undefined>): string | undefined {
    for (const name of ['origin', 'referer']) {
        const v = headers[name];
        if (typeof v !== 'string' || !v || v === 'null') continue;
        try {
            return new URL(v).host;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Whether a request is a sibling preview's, carrying this host's Lax cookies:
 * Sec-Fetch-Site (a header no page can set) says same-site, and it is not a
 * top-level GET navigation (a link, which is how the app opens a preview when
 * it is same-site with it). Until the preview domain is on the Public Suffix
 * List, every org's previews are one site: such a request is refused
 * (S1-WEB-01). A browser that does not send Sec-Fetch-* is not refused here.
 * With `self` (the host asked and the preview domain), a request whose
 * Origin (else Referer) is another expose of the same preview and side
 * (`-pr` and `-pr-2`) is the preview's own, never a sibling's (V-18).
 */
export function isSiblingPreviewRequest(headers: Record<string, string | string[] | undefined>, method: string | undefined, self?: { host: string; domain: string }): boolean {
    if (headers['sec-fetch-site'] !== 'same-site') return false;
    const topLevel = headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document' && (method === 'GET' || method === 'HEAD');
    if (topLevel) return false;
    if (self) {
        const from = requestOriginHost(headers);
        const mine = previewOf(self.host, self.domain);
        if (from && mine && previewOf(from, self.domain) === mine) return false;
    }
    return true;
}

/** The Cookie header the app gets: every cookie but the edge's own; undefined when none is left. */
export function withoutPreviewCookie(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined;
    const kept = cookieHeader
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith(`${PREVIEW_COOKIE}=`) && p !== PREVIEW_COOKIE);
    return kept.length ? kept.join('; ') : undefined;
}

// Hop-by-hop headers (RFC 9110 §7.6.1) and the ones HTTP/2 forbids (RFC 9113 §8.2.2).
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'http2-settings', 'proxy-authenticate', 'proxy-authorization']);
// What a client says about where it came from: never forwarded; the viewer's IP never reaches PR code.
const CLIENT_ORIGIN = /^(forwarded|x-forwarded-.*|x-real-ip|x-client-ip|true-client-ip|cf-connecting-ip|fastly-client-ip|x-cluster-client-ip|via)$/;
/** Stream headers only the edge sets (§9.1); a browser's copy is dropped. */
export const PREVIEW_STREAM_HEADERS = { previewId: 'kodus-preview-id', session: 'kodus-preview-session' } as const;

/**
 * The request headers the app gets from a browser's request: everything but
 * hop-by-hop, client-origin and Kodus headers and the edge's cookie, plus
 * the proto and host the browser used and X-Kodus-Preview.
 */
export function previewRequestHeaders(incoming: Record<string, string | string[] | undefined>, host: string): Record<string, string | string[]> {
    const listed = new Set(
        String(incoming.connection ?? '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    );
    const out: Record<string, string | string[]> = {};
    for (const [rawName, value] of Object.entries(incoming)) {
        const name = rawName.toLowerCase();
        if (value === undefined || name.startsWith(':') || name === 'host') continue;
        if (HOP_BY_HOP.has(name) || listed.has(name) || CLIENT_ORIGIN.test(name) || name.startsWith('kodus-') || name.startsWith('x-kodus-')) continue;
        if (name === 'cookie') {
            const kept = withoutPreviewCookie(Array.isArray(value) ? value.join('; ') : value);
            if (kept) out.cookie = kept;
            continue;
        }
        out[name] = value;
    }
    out['x-forwarded-proto'] = 'https';
    out['x-forwarded-host'] = host;
    out['x-kodus-preview'] = '1';
    return out;
}

/** HSTS on every preview response (§6.3): one year, subdomains, preload. */
export const PREVIEW_HSTS = 'max-age=31536000; includeSubDomains; preload';

/**
 * Whether a Set-Cookie value carries a Domain attribute as a browser parses
 * it (RFC 6265 §5.2): each attribute after the first `;`, its name up to the
 * first `=` (or all of it), trimmed and compared case-insensitively. So
 * `Domain =x`, ` domain= x`, `DOMAIN\t=x` and a bare `Domain` all count. A
 * Domain set from the page's own JS (document.cookie) never passes here; the
 * PSL entry is what stops that one (until then, isSiblingPreviewRequest and
 * PREVIEW_COOKIE_HEADER_MAX bound what it can do).
 */
export function hasDomainAttribute(setCookie: string): boolean {
    return setCookie
        .split(';')
        .slice(1)
        .some((attr) => {
            const eq = attr.indexOf('=');
            return (eq < 0 ? attr : attr.slice(0, eq)).trim().toLowerCase() === 'domain';
        });
}

/**
 * Whether a Set-Cookie names a cookie of the edge's own (`__Host-kodus…`,
 * `__Secure-kodus…`, the session cookie among them), by its name up to the
 * first `=`, trimmed, the prefix compared case-insensitively as browsers do.
 */
export function namesEdgeCookie(setCookie: string): boolean {
    const eq = setCookie.indexOf('=');
    const name = (eq < 0 ? setCookie.split(';')[0] : setCookie.slice(0, eq)).trim().toLowerCase();
    return name === PREVIEW_COOKIE.toLowerCase() || name.startsWith('__host-kodus') || name.startsWith('__secure-kodus');
}

/**
 * The response headers the browser gets from the app's: hop-by-hop removed,
 * any Set-Cookie with a Domain attribute dropped (until the domain is on the
 * PSL, a Domain cookie would reach every other preview), any Set-Cookie that
 * names the edge's own cookie dropped (PR code would clear the viewer's
 * session or fix it to one it holds), and the edge's own headers added. frame-ancestors goes in its own CSP header, which can only
 * narrow what the app sets (CSP3: every policy is enforced).
 */
export function previewResponseHeaders(app: Record<string, string | string[] | number | undefined>): { headers: Record<string, string | string[]>; droppedCookies: number } {
    const out: Record<string, string | string[]> = {};
    let droppedCookies = 0;
    let hasFrameOptions = false;
    for (const [rawName, value] of Object.entries(app)) {
        const name = rawName.toLowerCase();
        if (value === undefined || name.startsWith(':') || HOP_BY_HOP.has(name)) continue;
        if (name === 'strict-transport-security' || name === 'x-robots-tag') continue;
        if (name === 'set-cookie') {
            const cookies = (Array.isArray(value) ? value : [String(value)]).filter((c) => {
                const drop = hasDomainAttribute(c) || namesEdgeCookie(c);
                if (drop) droppedCookies++;
                return !drop;
            });
            if (cookies.length) out['set-cookie'] = cookies;
            continue;
        }
        if (name === 'x-frame-options') hasFrameOptions = true;
        out[name] = Array.isArray(value) ? value : String(value);
    }
    const csp = out['content-security-policy'];
    out['content-security-policy'] = [...(csp === undefined ? [] : Array.isArray(csp) ? csp : [csp]), "frame-ancestors 'self'"];
    if (!hasFrameOptions) out['x-frame-options'] = 'SAMEORIGIN';
    out['x-robots-tag'] = 'noindex, nofollow';
    out['strict-transport-security'] = PREVIEW_HSTS;
    return { headers: out, droppedCookies };
}

/**
 * Headers of the edge's own pages (/__kodus/*): nothing third-party, one
 * inline script by nonce, never framed, cached or indexed. `form`: the page
 * posts a form back to its own host (the session prompt), so form-action is
 * 'self' and the referrer policy same-origin: under no-referrer a browser
 * sends `Origin: null` on the POST, and the edge needs the real origin.
 */
export function previewEdgePageHeaders(nonce: string, opts: { form?: boolean } = {}): Record<string, string> {
    return {
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action ${opts.form ? "'self'" : "'none'"}`,
        'x-frame-options': 'DENY',
        'x-robots-tag': 'noindex, nofollow',
        'referrer-policy': opts.form ? 'same-origin' : 'no-referrer',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'strict-transport-security': PREVIEW_HSTS,
    };
}

// the tunnel (§4.2, §9.1)

export const PREVIEW_TUNNEL_PATH = '/v1/cells/tunnel';
export const PREVIEW_TUNNEL_AUTH_SCHEME = 'KodusTunnel';
export const PREVIEW_TUNNEL_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PREVIEW_TUNNEL_TICKET_TTL_SECONDS = 60;
export const newPreviewTunnelTicket = () => randomBytes(32).toString('base64url');
export const previewTicketHash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
/** The edge's tunnel endpoint as the hub sends it to a cell: wss to a DNS name (or the loopback in dev), this path only. */
export const PREVIEW_TUNNEL_URL_PATTERN = /^wss:\/\/((?:[A-Za-z0-9-]+\.)*[A-Za-z][A-Za-z0-9-]*|127\.0\.0\.1)(:[0-9]{1,5})?\/v1\/cells\/tunnel$/;

// the worker's preview routes (the env-session listener, signed like env sessions)

export const PREVIEW_ROUTES = { open: '/preview/open', status: '/preview/status', stop: '/preview/stop' } as const;
/** The worker's refusal when the deployment has no preview domain (decision 1): the API shows it as is. */
export const PREVIEW_OFF_CODE = 'preview_off';
/** An owner turned previews off for the org (§8.4). */
export const PREVIEW_DISABLED_CODE = 'preview_disabled';
/** The org's monthly preview time is used up (§5.4): refused at open and at a wake. */
export const PREVIEW_CAP_CODE = 'preview_cap';

/** Why a preview ended or is blocked, as the viewer reads it (the edge, the Run page, the PR comment). */
export const PREVIEW_REASONS = {
    disabled: 'Previews are off for this organization. An owner can turn them on in Kody Runtime settings.',
    forkOff: 'Preview is off for pull requests from forks. An owner can turn it on in Kody Runtime settings.',
    cap: "This month's preview time is used up. An owner can raise the cap in Kody Runtime settings.",
    newerRun: 'This preview is of an older commit. Open the newest Run of the pull request.',
    prClosed: 'The pull request was closed, so its preview ended.',
    newerSetup: 'The environment was set up again at a newer commit. Open its preview again.',
    security: 'Stopped by a security event on the preview machine. An owner can see it in the preview activity.',
    stopped: 'Stopped by a member.',
    record: 'This preview has ended (it is kept 7 days). Open the newest Run.',
} as const;

// the org's preview settings (§8.4, §9.5), stored by the API (runtime_settings.preview)

export const PREVIEW_FORKS = ['off', 'members'] as const;
export type PreviewForks = (typeof PREVIEW_FORKS)[number];
/** An environment's secrets in its previews (decision 4): none by default, or the same as its Runs. */
export const PREVIEW_SECRETS = ['none', 'run'] as const;
export type PreviewSecrets = (typeof PREVIEW_SECRETS)[number];
export const PREVIEW_IDLE_RANGE = { min: 5, max: 60 } as const;
/** One start's ceiling: never past the claim's own (HARD_EXPIRY_MINUTES.preview). */
export const PREVIEW_CEILING_RANGE = { min: 30, max: PREVIEW_CEILING_MINUTES } as const;
export const PREVIEW_MONTHLY_RANGE = { min: 60, max: 1_000_000 } as const;

const minutes = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);
export const PreviewSettingsSchema = z.strictObject({
    enabled: z.boolean(),
    forks: z.enum(PREVIEW_FORKS),
    idleMinutes: minutes(PREVIEW_IDLE_RANGE),
    ceilingMinutes: minutes(PREVIEW_CEILING_RANGE),
    /** Machine-minutes of previews per UTC month for the org; null: no cap. */
    monthlyMachineMinutes: minutes(PREVIEW_MONTHLY_RANGE).nullable(),
});
export type PreviewSettings = z.infer<typeof PreviewSettingsSchema>;
/** On by default where the deployment has a preview domain (§8.4); forks off (decision 6); decision 3's times; no cap. */
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
    enabled: true,
    forks: 'off',
    idleMinutes: PREVIEW_IDLE_MINUTES,
    ceilingMinutes: PREVIEW_CEILING_MINUTES,
    monthlyMachineMinutes: null,
};
/** The stored settings with a default for every field that is missing or no longer valid: a bad row never turns previews into something an owner did not set. */
export function previewSettingsOf(stored: unknown): PreviewSettings {
    const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
    const out = { ...DEFAULT_PREVIEW_SETTINGS };
    for (const key of Object.keys(out) as Array<keyof PreviewSettings>) {
        const field = PreviewSettingsSchema.shape[key].safeParse(s[key]);
        if (field.success) (out as Record<string, unknown>)[key] = field.data;
    }
    return out;
}

/**
 * What one open asks of the worker (from the org's settings and the
 * environment's, decided by the API): the idle stop and the ceiling of each
 * start, whether the claim gets the org's secrets, whether its PR side is a
 * fork's (no approved hosts, no secrets), and the monthly cap the worker
 * enforces at this open and at every wake.
 */
export const PreviewPolicySchema = z.strictObject({
    idleMinutes: minutes(PREVIEW_IDLE_RANGE),
    ceilingMinutes: minutes(PREVIEW_CEILING_RANGE),
    secrets: z.boolean(),
    forkPullRequest: z.boolean(),
    monthlyMachineMinutes: minutes(PREVIEW_MONTHLY_RANGE).optional(),
});
export type PreviewPolicy = z.infer<typeof PreviewPolicySchema>;
export const DEFAULT_PREVIEW_POLICY: PreviewPolicy = { idleMinutes: PREVIEW_IDLE_MINUTES, ceilingMinutes: PREVIEW_CEILING_MINUTES, secrets: false, forkPullRequest: false };
/**
 * The grant exchange on a preview host. GET /__kodus/session?grant=<jws>&to=<path>
 * shows a prompt naming the repository and PR; only its same-origin POST
 * (form fields grant, to) opens the session, so a cross-site redirect alone
 * never does (architecture review 2026-11-14, #4).
 */
export const PREVIEW_SESSION_PATH = '/__kodus/session';
/** A path the exchange may redirect to: absolute on the same host, never protocol-relative, never the edge's own pages. */
export const isPreviewReturnPath = (to: string) => /^\/(?![/\\])[\x21-\x7e]{0,2047}$/.test(to) && !to.startsWith(PREVIEW_RESERVED_PREFIX);

const id = z.string().min(1).max(128);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const PreviewOpenSchema = z
    .strictObject({
        organizationId: id,
        previewId: PreviewIdSchema,
        /** Absent: the environment's own preview (its base side at the last setup's commit). */
        runId: id.optional(),
        /** The pull request the Run is of: a newer Run of it or its closing ends the preview. */
        prNumber: z.number().int().min(1).optional(),
        environmentId: id,
        repositoryId: id,
        repositoryFullName: z.string().min(3).max(512),
        side: PreviewSideSchema,
        sha,
        sealedRepoToken: SealedTokenSchema,
        openedBy: id,
        /** Absent (an API from before the settings): decision 3's defaults, no secrets, no cap. */
        policy: PreviewPolicySchema.optional(),
    })
    .refine((o) => o.runId !== undefined || o.side === 'base', { message: 'an environment preview is of its base side', path: ['side'] });
export type PreviewOpen = z.infer<typeof PreviewOpenSchema>;
export const PreviewRefSchema = z.strictObject({ organizationId: id, previewId: PreviewIdSchema, actor: id.optional() });
export type PreviewRef = z.infer<typeof PreviewRefSchema>;

export interface PreviewView {
    previewId: string;
    /** Absent for an environment's own preview. */
    runId?: string;
    environmentId: string;
    repositoryId: string;
    side: PreviewSide;
    sha: string;
    host: string;
    state: PreviewState;
    /** The user who opened it first: they may stop it (§9.3). */
    openedBy: string;
    /** Why it is blocked, stopped or expired, for the viewer. */
    reason?: string;
    /** Started without the org's secrets (decision 4): the default. */
    withoutSecrets: boolean;
    /** The idle stop and one start's ceiling this preview runs with (the org's settings at its last open). */
    idleMinutes: number;
    ceilingMinutes: number;
    createdAt: string;
    expiresAt: string;
    lastActivityAt?: string;
    /** When the current start became ready. */
    readyAt?: string;
}

/** Audit actions (§6.7): grant and link actions belong to later phases' writers. */
export const PREVIEW_AUDIT_ACTIONS = ['session_opened', 'session_refused', 'started', 'woken', 'slept', 'stopped', 'expired'] as const;
export type PreviewAuditAction = (typeof PREVIEW_AUDIT_ACTIONS)[number];
/** Why a session was refused (runtime.preview.session reason). */
export const PREVIEW_REFUSALS = ['no_access', 'other_org', 'expired', 'grant_invalid', 'grant_replayed', 'not_found'] as const;
export type PreviewRefusal = (typeof PREVIEW_REFUSALS)[number];
