/**
 * Resolve the identifier used to delete a plugin's MCP connection.
 *
 * Prefer the resolved connection PK, but fall back to the plugin's
 * integrationId (its `id`, always known from the route). When the connections
 * list fails to load server-side, `connectionId` is absent — without the
 * fallback the disconnect action hard-throws "Connection ID not found" and the
 * user is stuck on a plugin shown as connected. The mcp-manager backend accepts
 * either identifier.
 */
export function resolveConnectionRef(plugin: {
    id?: string;
    connectionId?: string;
}): string | undefined {
    return plugin.connectionId ?? plugin.id;
}
