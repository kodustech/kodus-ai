import { authorizedFetch } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";

import { CODE_MANAGEMENT_API_PATHS } from "./types";

/** Mirror of the API's `FixedEgressIpView`. */
export type FixedEgressIp = {
    /** False on a self-hosted install: the card is not shown. */
    available: boolean;
    /** The organization's plan includes the fixed outbound IP. */
    allowedByPlan: boolean;
    /** The team's review sandboxes reach its Git host from the fixed IP. */
    enabled: boolean;
    /** `clone_fallback` when Kodus turned it on after a refused clone. */
    source?: "manual" | "clone_fallback";
    reason?: "ip_allow_list" | "forbidden" | "unreachable" | "other";
    updatedAt?: string;
    fixedIp?: string;
};

const UNAVAILABLE: FixedEgressIp = {
    available: false,
    allowedByPlan: false,
    enabled: false,
};

/** Server components: reads through the authorized server-side path. */
export const getFixedEgressIp = async (
    teamId: string,
): Promise<FixedEgressIp> => {
    const response = await authorizedFetch<FixedEgressIp>(
        CODE_MANAGEMENT_API_PATHS.FIXED_EGRESS_IP,
        { params: { teamId } },
    );
    return response ?? UNAVAILABLE;
};

// `axiosAuthorized.put` resolves to the response body, which the API wraps
// as `{ data, statusCode, type }`; callers want `data`.
export const setFixedEgressIp = async (params: {
    teamId: string;
    enabled: boolean;
}): Promise<FixedEgressIp> => {
    const { data } = await axiosAuthorized.put<{ data: FixedEgressIp }>(
        CODE_MANAGEMENT_API_PATHS.FIXED_EGRESS_IP,
        params,
    );
    return data;
};
