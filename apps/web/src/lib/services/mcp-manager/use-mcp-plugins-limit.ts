"use client";

import { useMemo } from "react";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

// Free/CE cap on simultaneously-running MCP plugins. Mirrors the backend
// enforcement in libs/mcp-server/services/mcp-manager.service.ts (slice on
// getConnections, driven by shouldLimitResources).
export const MCP_PLUGINS_FREE_LIMIT = 3;

export const useMCPPluginsLimit = (installedCount: number) => {
    const subscription = useSubscriptionStatus();

    return useMemo(() => {
        const total = installedCount;

        if (!subscription.valid)
            return {
                total,
                canInstallMore: false,
                limit: Number.POSITIVE_INFINITY,
                limited: false,
                plan: subscription.status,
            };

        if (
            subscription.status === "free" ||
            subscription.status === "self-hosted"
        )
            return {
                total,
                canInstallMore: total < MCP_PLUGINS_FREE_LIMIT,
                limit: MCP_PLUGINS_FREE_LIMIT,
                limited: true,
                plan: subscription.status,
            };

        return {
            total,
            canInstallMore: true,
            limit: Number.POSITIVE_INFINITY,
            limited: false,
            plan: subscription.status,
        };
    }, [subscription, installedCount]);
};
