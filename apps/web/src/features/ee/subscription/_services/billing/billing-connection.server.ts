import { cookies } from "next/headers";
// eslint-disable-next-line camelcase -- Next.js's own export name
import { unstable_rethrow } from "next/navigation";
import { getConnections } from "@services/setup/fetch";

import {
    BILLING_CONNECTION_COOKIE,
    parseBillingConnection,
} from "./billing-connection";

/**
 * The connection whose plan and seats the page manages, set only while the
 * workspace has several (counted across the whole workspace, not just the
 * connections this member reads). The cookie is only a preference: a
 * connection that left the workspace falls back to the first one, as the
 * picker shows. Undefined outside a request (no cookie store) or for a
 * workspace with one connection. A failed lookup throws: checkout and seat
 * changes must not land on the workspace plan by default.
 */
export const getBillingConnectionId = async (teamId: string) => {
    let selected: string | undefined;
    try {
        selected = parseBillingConnection(
            (await cookies()).get(BILLING_CONNECTION_COOKIE)?.value,
            teamId,
        );
    } catch (error) {
        unstable_rethrow(error);
        return undefined;
    }
    const gitConnections = (await getConnections(teamId)).filter(
        (connection) =>
            connection.category === "CODE_MANAGEMENT" &&
            connection.connectionId,
    );
    const connectionIds = gitConnections.map(
        (connection) => connection.connectionId as string,
    );
    const workspaceConnections = Math.max(
        connectionIds.length,
        gitConnections[0]?.workspaceConnectionCount ?? 0,
    );
    if (workspaceConnections < 2 || !connectionIds.length) return undefined;
    return selected && connectionIds.includes(selected)
        ? selected
        : connectionIds[0];
};
