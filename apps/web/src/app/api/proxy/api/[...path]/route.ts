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
 * Bearer injection: most fetches already set `Authorization` themselves
 * (via `authorizedFetch`), but `EventSource` cannot — it only forwards
 * cookies. We resolve the token from the NextAuth session and only
 * inject it when the incoming request is missing one, so SSE works
 * while regular fetches still control their own header.
 */
export const { GET, POST, PUT, PATCH, DELETE } = createProxyHandler({
    resolveUpstream: (path, search) => pathToApiUrl(path + search),
    proxyMountPath: "/api/proxy/api",
    resolveBearerToken: async (req) => {
        // Most fetches already include a Bearer header — leave them alone.
        // EventSource can't set headers, so we resolve the token from the
        // NextAuth session and inject it only when the incoming request
        // has none.
        if (req.headers.get("authorization")) return undefined;
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
