import "server-only";

import { NextRequest, NextResponse } from "next/server";

/**
 * Shared factory for the browser -> internal service proxy routes
 * introduced by the web-runtime-config-migration. All three proxies
 * (`/api/proxy/api`, `/api/proxy/mcp`, `/api/proxy/billing`) used to
 * duplicate the same forwarding logic; now they share this factory.
 *
 * Responsibilities:
 *  - Strip the incoming Host header so the upstream sees its own vhost.
 *  - Forward cookies, content-type, X-Forwarded-* intact.
 *  - Optionally inject an Authorization Bearer token (MCP case).
 *  - Block paths that must never be reachable from the browser
 *    (admin/metrics/internal routes) — applied BEFORE the upstream
 *    request so the backend never even sees them.
 *  - Rate-limit each sessionId to protect the backend from a
 *    compromised browser session.
 *  - Strip upstream Content-Encoding / Content-Length / Transfer-Encoding
 *    headers because undici auto-decompresses and the browser would
 *    otherwise reject with ERR_CONTENT_DECODING_FAILED.
 *  - Forward 3xx redirects to the browser instead of letting Node's
 *    fetch follow them server-side (which broke the SAML SSO
 *    initiation: the API issued a 302 to the IdP and the proxy
 *    silently fetched the IdP page). Internal-hostname Location
 *    headers are rewritten to a same-origin path on this proxy so the
 *    internal hostname never escapes the server.
 */

export type ProxyHandlerOptions = {
    /** Resolve the upstream URL from the remaining path + query string. */
    resolveUpstream: (upstreamPath: string, search: string) => string;
    /**
     * Same-origin path where this proxy is mounted, e.g.
     * "/api/proxy/api". Used to rewrite upstream Location headers that
     * point back at the internal hostname so the browser never sees it.
     * No trailing slash.
     */
    proxyMountPath: string;
    /**
     * Optional Bearer token resolver. Return value semantics:
     *   - string  → set `Authorization: Bearer <token>` (overrides any
     *               header the browser sent).
     *   - null    → delete the Authorization header before forwarding.
     *   - undefined → leave whatever the browser sent untouched. Useful
     *               for the /api proxy where regular fetches set their
     *               own bearer and only EventSource needs server-side
     *               injection.
     */
    resolveBearerToken?: (
        req: NextRequest,
    ) => Promise<string | null | undefined>;
    /**
     * Deny a request when the joined path matches any of these prefixes
     * (case-insensitive). Matches are done against the upstream path
     * starting with "/" — e.g. ["/admin", "/metrics/raw"].
     * Returns 404 (not 403) so attackers can't probe for existence.
     */
    denyPathPrefixes?: string[];
};

/**
 * Small in-process sliding-window limiter. Resets every window. Good
 * enough for single-instance selfhosted; a distributed deploy should
 * swap this for Redis/Memcached. The limit applies per
 * "session-identifying cookie" — we don't have a stable userId at this
 * layer so we hash the auth cookie.
 */
const RATE_LIMIT = { maxPerWindow: 120, windowMs: 10_000 } as const;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimitKey(req: NextRequest): string {
    // Cookie-based key is stable across tabs of the same session. Fall
    // back to IP-ish signal so unauthenticated misuse still gets bucketed.
    const cookie = req.headers.get("cookie") ?? "";
    const m = cookie.match(/authjs\.session-token=([^;]+)/);
    if (m) return `session:${m[1].slice(0, 16)}`;
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return `ip:${fwd.split(",")[0].trim()}`;
    return "anon";
}

function isRateLimited(key: string): boolean {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        rateBuckets.set(key, {
            count: 1,
            resetAt: now + RATE_LIMIT.windowMs,
        });
        return false;
    }
    bucket.count += 1;
    if (bucket.count > RATE_LIMIT.maxPerWindow) return true;
    return false;
}

function pathIsDenied(
    upstreamPath: string,
    denyPathPrefixes?: string[],
): boolean {
    if (!denyPathPrefixes?.length) return false;
    const normalized = upstreamPath.toLowerCase();
    return denyPathPrefixes.some((prefix) =>
        normalized.startsWith(prefix.toLowerCase()),
    );
}

/**
 * Normalize the path segments to prevent directory-traversal abuse
 * (`..`, empty, dot). Returns null when the path is unsafe so the
 * caller can 404 without forwarding.
 */
function normalizeUpstreamPath(segments: string[]): string | null {
    for (const segment of segments) {
        if (segment === ".." || segment === "." || segment.includes("\0")) {
            return null;
        }
    }
    return "/" + segments.join("/");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve and sanitize an upstream Location header for forwarding to
 * the browser.
 *
 * The upstream may emit:
 *   - A relative path ("/sso-callback") — pass through verbatim;
 *     browser resolves it against the current proxy URL, which is
 *     same-origin, so it just works.
 *   - An absolute URL on the upstream's *internal* origin
 *     ("http://kodus_api:3001/foo") — rewrite to a same-origin proxy
 *     path so the internal hostname never escapes the server. The
 *     browser will hit the proxy again on the next hop, which is what
 *     we want.
 *   - An absolute URL on a *different* origin — pass through (e.g.
 *     302 to an IdP entry point during SAML initiation, or to an S3
 *     signed URL during a download).
 *
 * Returns null only when the Location is unparseable; callers should
 * drop the header in that case rather than forwarding garbage.
 */
function rewriteLocation(
    location: string,
    upstreamUrl: string,
    proxyMountPath: string,
): string | null {
    try {
        const upstream = new URL(upstreamUrl);
        const resolved = new URL(location, upstream);

        if (resolved.origin === upstream.origin) {
            // Internal-origin redirect → keep path+query+hash, prepend
            // the same-origin proxy mount so the browser stays inside
            // the proxy chain.
            return (
                proxyMountPath +
                resolved.pathname +
                resolved.search +
                resolved.hash
            );
        }

        return resolved.toString();
    } catch {
        return null;
    }
}

async function forward(
    req: NextRequest,
    pathSegments: string[],
    options: ProxyHandlerOptions,
): Promise<NextResponse> {
    const upstreamPath = normalizeUpstreamPath(pathSegments);
    if (!upstreamPath) {
        return new NextResponse(null, { status: 404 });
    }

    if (pathIsDenied(upstreamPath, options.denyPathPrefixes)) {
        // 404 instead of 403 — makes path probing indistinguishable
        // from a typo.
        return new NextResponse(null, { status: 404 });
    }

    if (isRateLimited(rateLimitKey(req))) {
        return new NextResponse("Too Many Requests", { status: 429 });
    }

    const search = req.nextUrl.search;
    const url = options.resolveUpstream(upstreamPath, search);

    const headers = new Headers(req.headers);
    headers.delete("host");

    // Hop-by-hop headers (RFC 7230 §6.1) must not be forwarded by a
    // proxy. The AWS ALB adds `Connection: upgrade` to every request,
    // and forwarding it makes undici (Node's fetch) blow up with
    // `UND_ERR_INVALID_ARG: invalid connection header`, killing every
    // /api/proxy/* call with a TypeError. Stripping the full RFC list
    // also covers any future hop-by-hop quirk an upstream LB might add.
    for (const h of [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]) {
        headers.delete(h);
    }

    if (options.resolveBearerToken) {
        const token = await options.resolveBearerToken(req);
        if (typeof token === "string") {
            headers.set("Authorization", `Bearer ${token}`);
        } else if (token === null) {
            headers.delete("authorization");
        }
        // undefined → leave the incoming Authorization header alone.
    }

    const init: RequestInit = {
        method: req.method,
        headers,
        // Forward 3xx to the browser instead of letting undici follow
        // them server-side. Otherwise an API 302 to an IdP would have
        // the proxy fetch the IdP HTML and return that on the proxy
        // URL — which is exactly the bug that broke SAML SSO
        // initiation after the runtime-config migration.
        redirect: "manual",
        // Abort the upstream fetch when the browser disconnects.
        // Without this, an SSE stream's upstream connection would leak
        // because the proxy's `fetch` has no idea the client went away.
        signal: req.signal,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = req.body;
        (init as RequestInit & { duplex?: string }).duplex = "half";
    }

    const upstream = await fetch(url, init);

    // undici transparently decompresses — strip encoding-related
    // headers or the browser tries to decode plaintext and fails.
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    outHeaders.delete("transfer-encoding");

    if (REDIRECT_STATUSES.has(upstream.status)) {
        const rawLocation = upstream.headers.get("location");
        if (rawLocation) {
            const rewritten = rewriteLocation(
                rawLocation,
                url,
                options.proxyMountPath,
            );
            if (rewritten) {
                outHeaders.set("location", rewritten);
            } else {
                outHeaders.delete("location");
            }
        }
        // Redirect responses traditionally have no body; emit an empty
        // body so the browser doesn't render whatever stream the
        // upstream attached to a 3xx.
        return new NextResponse(null, {
            status: upstream.status,
            headers: outHeaders,
        });
    }

    return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: outHeaders,
    });
}

type RouteCtx = { params: Promise<{ path: string[] }> };
type MethodHandler = (req: NextRequest, ctx: RouteCtx) => Promise<NextResponse>;

/**
 * Produce the 5 HTTP method handlers a Next App Router route.ts
 * expects (GET, POST, PUT, PATCH, DELETE) from a single options bag.
 */
export function createProxyHandler(options: ProxyHandlerOptions): {
    GET: MethodHandler;
    POST: MethodHandler;
    PUT: MethodHandler;
    PATCH: MethodHandler;
    DELETE: MethodHandler;
} {
    const handler: MethodHandler = async (req, ctx) =>
        forward(req, (await ctx.params).path, options);

    return {
        GET: handler,
        POST: handler,
        PUT: handler,
        PATCH: handler,
        DELETE: handler,
    };
}

// Exports kept in-file (rather than in sibling test helpers) so the
// behaviour stays in one place. Tests import via the public factory.
export const __testing = {
    normalizeUpstreamPath,
    pathIsDenied,
    rewriteLocation,
};
