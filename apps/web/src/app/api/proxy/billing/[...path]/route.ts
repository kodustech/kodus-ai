import "server-only";

import { createUrl } from "src/core/utils/helpers";

import { createProxyHandler } from "../../_lib/create-proxy-handler";

function resolveBillingUpstream(path: string, search: string): string {
    let hostName = process.env.WEB_HOSTNAME_BILLING;
    if (hostName === "localhost") {
        hostName =
            process.env.GLOBAL_BILLING_CONTAINER_NAME ||
            "kodus-service-billing";
    }
    const port = process.env.WEB_PORT_BILLING;
    // The billing service expects its own routes under /api/billing/*,
    // so prefix the forwarded path here instead of leaking it into
    // every client caller. `internal: true` tells createUrl this is an
    // intra-network hop — http + port, no protocol guessing.
    return createUrl(hostName, port, "/api/billing" + path + search, {
        internal: true,
    });
}

/**
 * Proxy route that forwards browser fetches to the internal billing
 * service. Keeps WEB_HOSTNAME_BILLING out of the client bundle.
 */
export const { GET, POST, PUT, PATCH, DELETE } = createProxyHandler({
    resolveUpstream: resolveBillingUpstream,
    proxyMountPath: "/api/proxy/billing",
    denyPathPrefixes: ["/admin", "/internal", "/metrics", "/debug"],
});
