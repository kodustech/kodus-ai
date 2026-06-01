import "server-only";

import { auth } from "src/core/config/auth";
import { createUrl } from "src/core/utils/helpers";

import { createProxyHandler } from "../../_lib/create-proxy-handler";

function resolveMcpUpstream(path: string, search: string): string {
    let hostName = process.env.WEB_HOSTNAME_MCP_MANAGER;
    if (hostName === "localhost") {
        hostName =
            process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME ||
            "kodus-mcp-manager";
    }
    const port = process.env.WEB_PORT_MCP_MANAGER;
    return createUrl(hostName, port, path + search, { internal: true });
}

/**
 * Proxy route that forwards browser fetches to the internal MCP Manager.
 * Keeps WEB_HOSTNAME_MCP_MANAGER out of the client bundle and injects
 * the NextAuth-resolved Bearer token server-side.
 */
export const { GET, POST, PUT, PATCH, DELETE } = createProxyHandler({
    resolveUpstream: resolveMcpUpstream,
    proxyMountPath: "/api/proxy/mcp",
    resolveBearerToken: async () => {
        const session = await auth();
        return session?.user?.accessToken ?? null;
    },
    denyPathPrefixes: ["/admin", "/internal", "/metrics", "/debug"],
});
