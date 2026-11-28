"use client";

import { useSuspenseGetConnections } from "@services/setup/hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { readBillingConnectionId } from "../_services/billing/billing-connection.client";

/**
 * The Git connection whose plan and seats the subscription page manages.
 * `connectionId` is set only when the workspace has several: with one, calls
 * keep naming no connection, exactly as before.
 */
export const useBillingConnection = () => {
    const { teamId } = useSelectedTeamId();
    const connections = useSuspenseGetConnections(teamId).filter(
        (connection) => connection.category === "CODE_MANAGEMENT",
    );
    const selectedId = readBillingConnectionId(teamId);
    const connection =
        connections.find(
            (c) => c.connectionId && c.connectionId === selectedId,
        ) ?? connections[0];

    return {
        teamId,
        connections,
        connection,
        connectionId:
            connections.length > 1 ? connection?.connectionId : undefined,
    };
};
