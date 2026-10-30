import { MCP_CONNECTION_STATUS } from "@services/mcp-manager/types";

type LockablePlugin = {
    id: string;
    isConnected: boolean;
    isDefault?: boolean;
    connectionStatus?: MCP_CONNECTION_STATUS;
};

/**
 * Which connected plugins should render as "Locked" under the free plan's
 * cap. Default (system-managed) plugins like "Kodus MCP" are always on and
 * never count against the cap — they never appear in /mcp/connections at
 * all, so without this exclusion they'd look locked whenever they fell
 * outside the runnable set computed from that list.
 */
export function computeLockedPluginIds(
    plugins: LockablePlugin[],
    orderedActiveIntegrationIds: string[],
    limited: boolean,
    limit: number,
): Set<string> {
    if (!limited) return new Set();

    const runnable = new Set(orderedActiveIntegrationIds.slice(0, limit));

    return new Set(
        plugins
            .filter(
                (p) =>
                    p.isConnected &&
                    !p.isDefault &&
                    p.connectionStatus === MCP_CONNECTION_STATUS.ACTIVE &&
                    !runnable.has(p.id),
            )
            .map((p) => p.id),
    );
}

/** Plugins that count toward the free plan's cap — excludes defaults. */
export function countInstalledPlugins(plugins: LockablePlugin[]): number {
    return plugins.filter((p) => p.isConnected && !p.isDefault).length;
}
