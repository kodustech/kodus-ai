import { axiosAuthorized } from "src/core/utils/axios";
import { pathToApiUrl } from "src/core/utils/helpers";

import type {
    ExportResult,
    SaveScanSchedulePayload,
    SecurityScan,
    SecurityScanSchedule,
    StartSecurityScanPayload,
} from "./types";

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

export const cancelSecurityScan = async (
    scanId: string,
): Promise<SecurityScan> => {
    const response = await axiosAuthorized.post<{ data: SecurityScan }>(
        `${securityScansPath()}/${scanId}/cancel`,
        {},
    );

    return response.data;
};

export const securityScanSchedulesPath = () =>
    `${securityScansPath()}/schedules`;

export const exportDestinationsPath = () =>
    `${securityScansPath()}/export-destinations`;

export const saveSecurityScanSchedule = async (
    payload: SaveScanSchedulePayload,
): Promise<SecurityScanSchedule> => {
    const response = await axiosAuthorized.put<{ data: SecurityScanSchedule }>(
        securityScanSchedulesPath(),
        payload,
    );

    return response.data;
};

/** Pauses or resumes a schedule, leaving its settings as they are. */
export const setSecurityScanScheduleEnabled = async (
    teamId: string,
    repositoryId: string,
    enabled: boolean,
): Promise<SecurityScanSchedule> => {
    const response = await axiosAuthorized.patch<{
        data: SecurityScanSchedule;
    }>(`${securityScanSchedulesPath()}/${encodeURIComponent(repositoryId)}`, {
        teamId,
        enabled,
    });

    return response.data;
};

export const removeSecurityScanSchedule = async (
    teamId: string,
    repositoryId: string,
): Promise<void> => {
    await axiosAuthorized.deleted(
        `${securityScanSchedulesPath()}/${encodeURIComponent(repositoryId)}`,
        { params: { teamId } },
    );
};

/** Files these findings through a plugin; one result per finding asked. */
export const exportScanFindings = async (payload: {
    teamId: string;
    issueIds: string[];
    integrationId: string;
    destinationNote?: string;
}): Promise<ExportResult[]> => {
    const response = await axiosAuthorized.post<{ data: ExportResult[] }>(
        `${securityScansPath()}/issues/export`,
        payload,
    );

    return response.data;
};
