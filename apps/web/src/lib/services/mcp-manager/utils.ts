import { typedFetch } from "@services/fetch";
import { auth } from "src/core/config/auth";
import { createUrl } from "src/core/utils/helpers";
import { isServerSide } from "src/core/utils/server-side";

import { MCPServiceUnavailableError } from "./errors";

// Re-exported for backward compatibility with callers that imported the
// error class from this file.
export { MCPServiceUnavailableError } from "./errors";

/**
 * MCP Manager fetch utility.
 *
 * Dual-mode by design:
 *   - Server side: calls the MCP Manager directly using the internal
 *     hostname (process.env.WEB_HOSTNAME_MCP_MANAGER / container name).
 *   - Client side: routes through /api/proxy/mcp/<path>, which runs on
 *     the Next server and performs the same upstream call. This keeps
 *     the MCP hostname out of the client bundle entirely — see
 *     apps/web/src/app/api/proxy/mcp/[...path]/route.ts.
 *
 * Note: MCP Manager is an optional service. If it's not running, this
 * throws MCPServiceUnavailableError, which callers can catch to handle
 * gracefully (e.g. render an empty state).
 */
export const mcpManagerFetch = async <Data>(
    _url: Parameters<typeof typedFetch>[0],
    config?: Parameters<typeof typedFetch>[1],
): Promise<Data> => {
    let authorization: string | undefined;
    let url: string;

    if (isServerSide) {
        const jwtPayload = await auth();
        authorization = jwtPayload?.user.accessToken;

        let hostName = process.env.WEB_HOSTNAME_MCP_MANAGER;
        if (hostName === "localhost") {
            hostName =
                process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME ||
                "kodus-mcp-manager";
        }
        const port = process.env.WEB_PORT_MCP_MANAGER;
        url = createUrl(hostName, port, _url.toString(), { internal: true });
    } else {
        // Client calls route through /api/proxy/mcp, which injects the Bearer
        // from the httpOnly session cookie server-side — so the browser never
        // fetches /api/auth/session or attaches a token itself.
        const path = _url.toString();
        const normalized = path.startsWith("/") ? path : `/${path}`;
        url = `/api/proxy/mcp${normalized}`;
    }

    try {
        return await typedFetch<Data>(url, {
            ...config,
            headers: {
                ...config?.headers,
                // Only server-side direct calls need the token; the proxy
                // injects it for client calls.
                ...(authorization
                    ? { Authorization: `Bearer ${authorization}` }
                    : {}),
            },
        });
    } catch (error) {
        // Service unavailable — MCP Manager might not be running.
        if (
            error instanceof Error &&
            (error.message.includes("ENOTFOUND") ||
                error.message.includes("ECONNREFUSED") ||
                error.message.includes("Failed to fetch") ||
                error.message.includes("fetch failed"))
        ) {
            console.warn("[MCP Manager] Service unavailable:", error.message);
            throw new MCPServiceUnavailableError();
        }
        throw error;
    }
};
