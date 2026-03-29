export type MCPConnectionLike = {
    integrationId: string;
    appName: string;
    allowedTools?: string[];
};

export type MCPMentionGroupLike = {
    groupLabel: string;
    items: Array<{
        type: "mcp";
        value: string;
        label: string;
        meta?: { appName: string };
        children?: () => MCPMentionGroupLike[];
    }>;
};

export const mapMCPConnectionsToMentionGroups = (
    connections: MCPConnectionLike[],
): MCPMentionGroupLike[] => [
    {
        groupLabel: "MCP",
        items: connections.map((connection) => ({
            type: "mcp" as const,
            value: connection.integrationId,
            label: connection.appName,
            children: () => [
                {
                    groupLabel: connection.appName,
                    items: (connection.allowedTools ?? []).map((tool) => ({
                        type: "mcp" as const,
                        value: `${connection.integrationId}:${tool}`,
                        label: tool,
                        meta: { appName: connection.appName },
                    })),
                },
            ],
        })),
    },
];
