import type { INTEGRATIONS_KEY } from "@enums";
import { authorizedFetch } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";

import { SETUP_PATHS } from ".";

/** GitHub's authorization page for linking `installationId` (see github-installation-authorization). */
export async function getGithubInstallationAuthorizationUrl(
    installationId: string,
    /** Sealed into GitHub's round trip, so this link alone adds a connection. */
    newConnection?: boolean,
): Promise<string> {
    const response = await axiosAuthorized.fetcher<{ data: { url: string } }>(
        SETUP_PATHS.GITHUB_INSTALLATION_AUTHORIZATION,
        {
            params: {
                installationId,
                ...(newConnection ? { newConnection: "true" } : {}),
            },
        },
    );
    return response.data.url;
}

export function getConnectionsOnClient(teamId: string) {
    return axiosAuthorized
        .fetcher(SETUP_PATHS.CONNECTIONS, {
            params: { teamId },
        })
        .then((r) => r.data)
        .catch((error) => {
            console.error("Failed to fetch connections:", error);
            return [];
        }) as Promise<
        Array<{
            platformName: keyof typeof INTEGRATIONS_KEY;
            isSetupComplete: boolean;
            hasConnection: boolean;
            category:
                "COMMUNICATION" | "PROJECT_MANAGEMENT" | "CODE_MANAGEMENT";
            config?: { [key: string]: string };
            /** The Git connection (code management only). */
            connectionId?: string;
            connectionName?: string | null;
            reviewEnabled?: boolean;
            /** Every Git connection of the workspace, those the member is not granted included. */
            workspaceConnectionCount?: number;
            /** Billed on a subscription of its own; null when billing could not be read. */
            ownSubscription?: boolean | null;
        }>
    >;
}

export function getConnections(teamId: string) {
    return authorizedFetch(SETUP_PATHS.CONNECTIONS, {
        params: { teamId },
    }) as Promise<
        Array<{
            platformName: keyof typeof INTEGRATIONS_KEY;
            isSetupComplete: boolean;
            hasConnection: boolean;
            category:
                "COMMUNICATION" | "PROJECT_MANAGEMENT" | "CODE_MANAGEMENT";
            config?: { [key: string]: string };
            /** The Git connection (code management only). */
            connectionId?: string;
            connectionName?: string | null;
            reviewEnabled?: boolean;
            /** Every Git connection of the workspace, those the member is not granted included. */
            workspaceConnectionCount?: number;
            /** Billed on a subscription of its own; null when billing could not be read. */
            ownSubscription?: boolean | null;
        }>
    >;
}
