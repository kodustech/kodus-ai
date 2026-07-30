import "server-only";

import { auth } from "src/core/config/auth";
import { pathToApiUrl } from "src/core/utils/helpers";

import { createProxyHandler } from "../../_lib/create-proxy-handler";

/**
 * Proxy route that forwards browser fetches to the internal backend API.
 * Keeps WEB_HOSTNAME_API / WEB_PORT_API out of the client bundle.
 *
 * Denylist: paths the browser must never reach even when authenticated.
 * These endpoints historically assumed network-layer isolation (VPC
 * private ingress, localhost-only) and are not prepared to be exposed
 * through a same-origin proxy.
 *
 * Bearer injection: the proxy is the SINGLE authority on the upstream
 * `Authorization` header. It always derives the Bearer from the httpOnly
 * NextAuth session cookie server-side and ignores/overrides whatever the
 * browser sent. This (a) lets the client stop fetching `/api/auth/session`
 * and attaching the token per request, (b) keeps the backend access token
 * out of client-reachable JS, and (c) prevents a compromised browser from
 * dictating the token. EventSource (which can't set headers) is covered by
 * the same path.
 */
export const { GET, POST, PUT, PATCH, DELETE } = createProxyHandler({
    resolveUpstream: (path, search) => pathToApiUrl(path + search),
    proxyMountPath: "/api/proxy/api",
    resolveBearerToken: async () => {
        // Always inject the server-derived token; never trust a client-sent
        // Authorization header. `string` overrides it, `null` deletes it
        // (unauthenticated request → upstream handles as anonymous).
        const session = await auth();
        return session?.user?.accessToken ?? null;
    },
    denyPathPrefixes: [
        "/admin",
        "/internal",
        "/metrics",
        "/debug",
        "/health/raw",
    ],
});
