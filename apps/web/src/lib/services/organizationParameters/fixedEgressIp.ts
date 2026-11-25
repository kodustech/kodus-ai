import { authorizedFetch } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";

import { ORGANIZATION_PARAMETERS_PATHS } from "./index";

/** Mirror of the API's `FixedEgressIpView`. */
export type FixedEgressIp = {
    /** False where the setting changes nothing: the card is not shown. */
    available: boolean;
    /** The organization's plan includes the fixed outbound IP. */
    allowedByPlan: boolean;
    /** Billing could not confirm the plan: turning it on is refused for now. */
    planUnconfirmed?: boolean;
    /** The organization's review sandboxes reach its Git host from the fixed IP. */
    enabled: boolean;
    /** The stored choice is on, even when the plan does not use it. */
    savedOn?: boolean;
    /** Direct egress is rolled out to the organization. */
    inRollout?: boolean;
    /** `clone_fallback` when Kodus turned it on after a refused clone. */
    source?: "manual" | "clone_fallback";
    /** An owner turned it off: a refused clone does not turn it back on. */
    turnedOff?: boolean;
    reason?: "ip_allow_list" | "forbidden" | "unreachable" | "other";
    updatedAt?: string;
    fixedIp?: string;
};

/**
 * Server components: reads through the authorized server-side path. A read
 * that brings no setting throws rather than answer "not available", so the
 * page can tell a failed load from an organization without the card.
 */
export const getFixedEgressIp = async (): Promise<FixedEgressIp> => {
    const response = await authorizedFetch<FixedEgressIp>(
        ORGANIZATION_PARAMETERS_PATHS.FIXED_EGRESS_IP,
    );
    if (!response) {
        throw new Error("The fixed outbound IP setting came back empty");
    }
    return response;
};

// `axiosAuthorized.put` resolves to the response body, which the API wraps
// as `{ data, statusCode, type }`; callers want `data`.
export const setFixedEgressIp = async (params: {
    enabled: boolean;
}): Promise<FixedEgressIp> => {
    const { data } = await axiosAuthorized.put<{ data: FixedEgressIp }>(
        ORGANIZATION_PARAMETERS_PATHS.FIXED_EGRESS_IP,
        params,
    );
    return data;
};
