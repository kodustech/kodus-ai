"use client";

import { useEffect, useRef } from "react";
import {
    isSecurityScanActive,
    type SecurityScan,
} from "@services/security-scans/types";
import { useQueryClient } from "@tanstack/react-query";
import { pathToApiUrl } from "src/core/utils/helpers";

/**
 * Refreshes the issues when a scan finishes or stores findings: a running
 * scan writes them as it goes, and the lists should show them without
 * waiting for the end.
 */
export const useRefreshIssuesAsScansProgress = (
    scans: SecurityScan[],
    isFetched: boolean,
) => {
    const queryClient = useQueryClient();
    const previousStates = useRef<Map<string, string>>(null);

    useEffect(() => {
        if (!isFetched) return;

        const stateOf = (s: (typeof scans)[number]) =>
            `${isSecurityScanActive(s)}:${(s.outcome?.created ?? 0) + (s.outcome?.reopened ?? 0) + (s.outcome?.resolved ?? 0)}`;
        const previous = previousStates.current;
        const current = new Map(scans.map((s) => [s.uuid, stateOf(s)]));
        previousStates.current = current;

        if (!previous) return;

        // A scan seen before whose state moved, or one that shows up already
        // finished (a short scan done before the next poll): either stored
        // or resolved findings the lists do not show yet.
        const changed = scans.some((s) => {
            const before = previous.get(s.uuid);
            return before
                ? before !== current.get(s.uuid)
                : !isSecurityScanActive(s);
        });

        if (changed) {
            queryClient.invalidateQueries({
                queryKey: [pathToApiUrl("/issues")],
            });
            queryClient.invalidateQueries({
                queryKey: [pathToApiUrl("/issues/count")],
            });
        }
    }, [scans, isFetched, queryClient]);
};
