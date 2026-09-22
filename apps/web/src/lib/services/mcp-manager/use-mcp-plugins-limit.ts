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

        // An invalid license (no license row, canceled, expired, failed
        // payment) is capped by the backend exactly like Free — see
        // `shouldLimitResources`. Reporting `limited: false` here hid the
        // locked banner from precisely those orgs, so plugins were skipped
        // during reviews with nothing on screen saying so. `inactive` is
        // billing not answering, not a verdict, so it stays uncapped.
        if (!subscription.valid && subscription.status === "inactive")
            return {
                total,
                canInstallMore: false,
                limit: Number.POSITIVE_INFINITY,
                limited: false,
                plan: subscription.status,
            };

        if (
            !subscription.valid ||
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
