import { getConnections } from "@services/setup/fetch";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import {
    BILLING_CONNECTION_COOKIE,
    parseBillingConnection,
} from "./billing-connection";

/**
 * The connection whose plan and seats the page manages, set only while the
 * workspace has several. The cookie is only a preference: a connection that
 * left the workspace falls back to the first one, as the picker shows.
 * Undefined outside a request (no cookie store) or when the connections
 * cannot be read: the workspace's own plan.
 */
export const getBillingConnectionId = async (teamId: string) => {
    try {
        const selected = parseBillingConnection(
            (await cookies()).get(BILLING_CONNECTION_COOKIE)?.value,
            teamId,
        );
        const connectionIds = (await getConnections(teamId))
            .filter(
                (connection) =>
                    connection.category === "CODE_MANAGEMENT" &&
                    connection.connectionId,
            )
            .map((connection) => connection.connectionId as string);
        if (connectionIds.length < 2) return undefined;
        return selected && connectionIds.includes(selected)
            ? selected
            : connectionIds[0];
    } catch (error) {
        // eslint-disable-next-line camelcase
        unstable_rethrow(error);
        return undefined;
    }
};
