import {
    getMCPConnections,
    getMCPPluginById,
    getMCPPlugins,
    getMCPPluginTools,
} from "@services/mcp-manager/fetch";
import type { AwaitedReturnType } from "src/core/types";

import { PluginModal } from "./_components/modal";

export default async function PluginModalPage({
    params,
}: {
    params: Promise<{ provider: string; id: string }>;
}) {
    const { id, provider } = await params;
    let installedPlugins: AwaitedReturnType<typeof getMCPPlugins> = [];
    let tools: AwaitedReturnType<typeof getMCPPluginTools> = [];

    // These three only need { id, provider } and don't depend on each other —
    // fetch them in one round-trip. Tools keeps its own catch so a tools
    // failure degrades gracefully instead of taking the whole modal down.
    let plugin;
    try {
        const [pluginResult, allPlugins, fetchedTools] = await Promise.all([
            getMCPPluginById({ id, provider }),
            getMCPPlugins(),
            getMCPPluginTools({ id, provider }).catch((error) => {
                console.error(
                    "Error fetching plugin tools, continuing without them:",
                    error,
                );
                return [] as AwaitedReturnType<typeof getMCPPluginTools>;
            }),
        ]);
        plugin = pluginResult;
        installedPlugins = allPlugins.filter((p) => p.isConnected);
        tools = fetchedTools || [];
    } catch (error) {
        console.error("Error fetching plugin data:", error);
        return null;
    }

    if (!plugin) {
        console.error("Plugin not found");
        return null;
    }

    if (plugin.isConnected) {
        try {
            const connectionsResponse = await getMCPConnections();
            const connections = connectionsResponse.items || [];
            const connection = connections.find(
                (conn) => conn.integrationId === id,
            );

            if (connection) {
                const pluginWithConnection = {
                    ...plugin,
                    allowedTools: connection.allowedTools || [],
                    connectionId: connection.id,
                };

                return (
                    <PluginModal
                        tools={tools}
                        plugin={pluginWithConnection}
                        installedPlugins={installedPlugins}
                    />
                );
            }
        } catch (connectionError) {
            console.error("Error fetching connections:", connectionError);
            console.error(
                "Error details:",
                JSON.stringify(connectionError, null, 2),
            );
        }
    }

    return (
        <PluginModal
            tools={tools}
            plugin={plugin}
            installedPlugins={installedPlugins}
        />
    );
}
