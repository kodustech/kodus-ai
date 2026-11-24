import { cookies } from "next/headers";

import {
    BILLING_CONNECTION_COOKIE,
    parseBillingConnection,
} from "./billing-connection";

/** Undefined outside a request (no cookie store): the workspace's own plan. */
export const getBillingConnectionId = async (teamId: string) => {
    try {
        return parseBillingConnection(
            (await cookies()).get(BILLING_CONNECTION_COOKIE)?.value,
            teamId,
        );
    } catch {
        return undefined;
    }
};
