import { useFetch } from "src/core/utils/reactQuery";
import { safeArray } from "src/core/utils/safe-array";

import { securityScansPath } from "./fetch";
import { isSecurityScanActive, type SecurityScan } from "./types";

const SECURITY_SCANS_LIST_LIMIT = 20;
const ACTIVE_SCAN_POLL_MS = 10_000;

/** Recent scans, most recent first. Polls while any scan is queued or running. */
export const useSecurityScans = () => {
    const { data, ...query } = useFetch<SecurityScan[]>(
        securityScansPath(),
        { params: { limit: SECURITY_SCANS_LIST_LIMIT } },
        true,
        {
            placeholderData: (prev) => prev,
            refetchInterval: (q) =>
                safeArray(q.state.data).some(isSecurityScanActive)
                    ? ACTIVE_SCAN_POLL_MS
                    : false,
        },
    );

    return { ...query, data: safeArray(data) };
};
