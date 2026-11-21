import { PREVIEW_COOKIE } from '@libs/runtime/contracts/preview';

// What the edge answers to a Cookie header past PREVIEW_COOKIE_HEADER_MAX
// (S1-WEB-01): Set-Cookie values that expire each cookie of the header but
// the edge's own session. Until the preview domain is on the Public Suffix
// List, a page of any preview can set cookies on the whole preview domain,
// at any path. Deleting one takes its exact name, domain and path. The
// header gives only names, so each name is expired on the preview domain
// and host-only, at every path the browser may have stored it under: a
// cookie it sent on this request has a path that is a prefix of this
// request's path (RFC 6265 §5.1.4), with or without a trailing slash.

/** The Set-Cookie bytes one answer carries, well under what browsers and load balancers accept in a response. */
export const CLEARING_MAX_BYTES = 32 * 1024;
/** Path depth covered per answer; a cookie set deeper is cleared from the deepest of these prefixes up. */
const MAX_PATH_SEGMENTS = 8;
/** An RFC 6265 cookie-name token; anything else is never echoed back in a header. */
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
/** A path segment safe to echo in a Path attribute: no ';', no space, no control character. */
const SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,=:@%]{1,256}$/;

/** "/", then each prefix of the path, with and without its trailing slash. */
export function cookiePathPrefixes(pathname: string): string[] {
    const paths = ['/'];
    const segments = pathname.split('/').slice(1);
    const trailing = pathname.length > 1 && pathname.endsWith('/');
    const parts = trailing ? segments.slice(0, -1) : segments;
    for (let i = 0; i < Math.min(parts.length, MAX_PATH_SEGMENTS); i++) {
        if (!SEGMENT.test(parts[i])) break;
        const prefix = `/${parts.slice(0, i + 1).join('/')}`;
        paths.push(prefix);
        if (i < parts.length - 1 || trailing) paths.push(`${prefix}/`);
    }
    return paths;
}

/**
 * Set-Cookie values expiring the cookies of this header but the edge's own,
 * the largest first, every path of a name or none of it, within
 * CLEARING_MAX_BYTES: a browser carrying more gets the rest on its next
 * request, which is still past the threshold.
 */
export function previewCookieClearingFor(cookieHeader: string | undefined, domain: string, pathname: string): string[] {
    const sizes = new Map<string, number>();
    for (const part of (cookieHeader ?? '').split(';')) {
        const eq = part.indexOf('=');
        const name = (eq < 0 ? part : part.slice(0, eq)).trim();
        if (!name || name === PREVIEW_COOKIE || !NAME.test(name)) continue;
        sizes.set(name, (sizes.get(name) ?? 0) + part.length);
    }
    const names = [...sizes.entries()].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)).map(([name]) => name);
    const paths = cookiePathPrefixes(pathname);
    const out: string[] = [];
    let bytes = 0;
    for (const name of names) {
        const values = paths.flatMap((path) => [`${name}=; Max-Age=0; Path=${path}; Domain=${domain}; Secure`, `${name}=; Max-Age=0; Path=${path}; Secure`]);
        const size = values.reduce((n, v) => n + v.length, 0);
        if (bytes + size > CLEARING_MAX_BYTES) break;
        out.push(...values);
        bytes += size;
    }
    return out;
}
