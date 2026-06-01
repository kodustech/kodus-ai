"use client";

import { useMemo } from "react";
import type { MentionGroup } from "@components/ui/rich-text-editor-with-mentions";
import { useMCPAvailability } from "@services/mcp-manager/hooks";
import { MCPServiceUnavailableError } from "@services/mcp-manager/errors";
import { useQuery } from "@tanstack/react-query";
import { getMCPConnections } from "src/lib/services/mcp-manager/fetch";

import { mapMCPConnectionsToMentionGroups } from "./mcp-mentions-state";

export function useMCPMentions() {
    const { data: isMCPAvailable } = useMCPAvailability();
    const { data: mcpConnections } = useQuery({
        queryKey: ["mcp-connections"],
        enabled: isMCPAvailable === true,
        staleTime: 5 * 60 * 1000,
        retry: false,
        queryFn: async () => {
            try {
                const response = await getMCPConnections();
                return response.items ?? [];
            } catch (error) {
                if (error instanceof MCPServiceUnavailableError) {
                    return [];
                }

                console.error("Failed to fetch MCP connections:", error);
                return [];
            }
        },
    });

    const mcpGroups = useMemo(
        () =>
            mapMCPConnectionsToMentionGroups(
                (mcpConnections ?? []) as Array<{
                    integrationId: string;
                    appName: string;
                    allowedTools?: string[];
                }>,
            ) as MentionGroup[],
        [mcpConnections],
    );

    const formatInsertByType = useMemo(
        () => ({
            mcp: (i: any) => {
                const rawApp = String(i?.meta?.appName ?? "");
                const app = rawApp
                    .toLowerCase()
                    .replace(/\bmcp\b/g, "")
                    .replace(/[^a-z0-9]+/g, "_")
                    .replace(/^_+|_+$/g, "");
                const tool = String(i.label).toLowerCase();
                return `@mcp<${app}|${tool}> `;
            },
        }),
        [],
    );

    return {
        mcpGroups,
        formatInsertByType,
    };
}
