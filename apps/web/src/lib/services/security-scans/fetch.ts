import { axiosAuthorized } from "src/core/utils/axios";
import { pathToApiUrl } from "src/core/utils/helpers";

import type { SecurityScan, StartSecurityScanPayload } from "./types";

// A function, not a constant: pathToApiUrl resolves to the same-origin proxy
// only when called in the browser.
export const securityScansPath = () => pathToApiUrl("/security-scans");

export const startSecurityScan = async (
    payload: StartSecurityScanPayload,
): Promise<SecurityScan> => {
    const response = await axiosAuthorized.post<{ data: SecurityScan }>(
        securityScansPath(),
        payload,
    );

    return response.data;
};
