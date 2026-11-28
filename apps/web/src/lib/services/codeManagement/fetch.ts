import {
    AuthMode,
    OrganizationAndTeamData,
    PlatformType,
} from "src/core/types";
import { axiosAuthorized } from "src/core/utils/axios";

import {
    clearConnectionIntent,
    readConnectionIntent,
} from "./connection-intent";
import {
    CODE_MANAGEMENT_API_PATHS,
    type Repository,
    type RepositoryUploadResult,
} from "./types";

export const getRepositories = async (
    teamId: string,
    organizationSelected?: any,
    connectionId?: string,
) => {
    const { data }: { data: any[] } = await axiosAuthorized.fetcher(
        CODE_MANAGEMENT_API_PATHS.GET_REPOSITORIES_ORG,
        {
            params: {
                teamId,
                organizationSelected,
                ...(connectionId ? { connectionId } : {}),
            },
        },
    );

    return data;
};

export const createOrUpdateRepositories = (
    repositories: Repository[],
    teamId: string,
    type: "replace" | "append" = "replace",
    options?: {
        /**
         * Tells the backend not to set up webhooks for this request because
         * the selection it persists is not the complete one yet.
         *
         * Only the chunked save sets it. Every provider reconciles webhooks
         * against the persisted selection, so an intermediate chunk makes them
         * act on a partial one: with 200 repositories saved in chunks of 50,
         * the first chunk persists 50 and the providers that remove webhooks
         * for repositories outside the selection delete the other 150, which
         * the later chunks then recreate. Those repositories are left without
         * a webhook in between, which silently drops their PR events, and the
         * hooks never come back if the process dies mid-save.
         */
        deferWebhooks?: boolean;
        /** The Git connection the repositories belong to. */
        connectionId?: string;
    },
) => {
    return axiosAuthorized.post(
        CODE_MANAGEMENT_API_PATHS.CREATE_OR_UPDATE_REPOSITORIES_CONFIG,
        {
            repositories,
            teamId,
            type,
            ...(options?.deferWebhooks ? { deferWebhooks: true } : {}),
            ...(options?.connectionId
                ? { connectionId: options.connectionId }
                : {}),
        },
    );
};

export const createOrUpdateRepositoriesInChunks = async (
    repositories: Repository[],
    teamId: string,
    onProgress?: (current: number, total: number) => void,
    connectionId?: string,
): Promise<RepositoryUploadResult> => {
    const CHUNK_SIZE = 50;
    const chunks = [];

    for (let i = 0; i < repositories.length; i += CHUNK_SIZE) {
        chunks.push(repositories.slice(i, i + CHUNK_SIZE));
    }

    const results: RepositoryUploadResult = {
        success: 0,
        failed: 0,
        errors: [],
    };

    for (let i = 0; i < chunks.length; i++) {
        const type = i === 0 ? "replace" : "append";
        const isLastChunk = i === chunks.length - 1;
        try {
            // Webhooks are set up once, by the last chunk, against the
            // complete selection.
            await createOrUpdateRepositories(chunks[i], teamId, type, {
                deferWebhooks: !isLastChunk,
                connectionId,
            });
            results.success += chunks[i].length;
        } catch (error) {
            results.failed += chunks[i].length;
            results.errors.push(`Chunk ${i + 1} failed`);
        }
        onProgress?.(results.success + results.failed, repositories.length);
    }

    return results;
};

export const createCodeManagementIntegration = ({
    integrationType,
    organizationAndTeamData,
    authMode = AuthMode.OAUTH,
    installationId,
    host = "",
    code = "",
    githubCode,
    githubState,
    token = "",
    username = "",
    email = "",
    orgName = "",
    connectionId,
}: {
    integrationType: PlatformType;
    organizationAndTeamData: OrganizationAndTeamData;
    authMode?: AuthMode;
    host?: string;
    code?: any;
    installationId?: any;
    /** GitHub's authorization of the user for linking `installationId`. */
    githubCode?: string;
    githubState?: string;
    token?: string;
    username?: string;
    email?: string;
    orgName?: string;
    /** Reconnect this Git connection instead of the workspace's default one. */
    connectionId?: string;
}) => {
    const authCode = installationId || code;
    // An "Add connection" flow started before the provider redirect.
    const intent = connectionId ? undefined : readConnectionIntent();

    if (!token && !authCode) {
        throw new Error(
            "Either installationId or code must be provided when token is not present",
        );
    }
    return axiosAuthorized
        .post<{
            statusCode: number;
            data: {
                success: boolean;
                status: "SUCCESS" | "NO_ORGANIZATION" | "NO_REPOSITORIES";
                /** The Git connection created or updated. */
                integrationId?: string;
            };
        }>(CODE_MANAGEMENT_API_PATHS.CREATE_AUTH_INTEGRATION, {
            code: authCode,
            githubCode,
            githubState,
            integrationType,
            organizationAndTeamData,
            authMode,
            token,
            host,
            username,
            email,
            orgName,
            ...(connectionId ? { connectionId } : {}),
            ...(intent ?? {}),
        })
        .then((response) => {
            if (intent && response?.data?.success) clearConnectionIntent();
            return response;
        });
};

export const updateConnection = (params: {
    teamId: string;
    connectionId: string;
    name?: string | null;
    reviewEnabled?: boolean;
}) => {
    const { teamId, connectionId, ...body } = params;
    return axiosAuthorized.patch(
        CODE_MANAGEMENT_API_PATHS.CONNECTION(connectionId),
        body,
        { params: { teamId } },
    );
};

export const getConnectionAccess = async (
    teamId: string,
    connectionId: string,
) => {
    const { data } = await axiosAuthorized.fetcher<{
        data: { userIds: string[] };
    }>(CODE_MANAGEMENT_API_PATHS.CONNECTION_ACCESS(connectionId), {
        params: { teamId },
    });
    // An unreadable answer is not "no one": callers must not save over it.
    if (!Array.isArray(data?.userIds)) {
        throw new Error("Could not read who reads this connection");
    }
    return data.userIds;
};

export const setConnectionAccess = (
    teamId: string,
    connectionId: string,
    userIds: string[],
) =>
    axiosAuthorized.put(
        CODE_MANAGEMENT_API_PATHS.CONNECTION_ACCESS(connectionId),
        { userIds },
        { params: { teamId } },
    );

export const finishOnboarding = (params: {
    teamId: string;
    reviewPR: boolean;
    repositoryId?: string;
    repositoryName?: string;
    pullNumber?: number;
}) => {
    const { teamId, reviewPR, repositoryId, repositoryName, pullNumber } =
        params;
    return axiosAuthorized.post(CODE_MANAGEMENT_API_PATHS.FINISH_ONBOARDING, {
        teamId,
        reviewPR,
        repositoryId,
        repositoryName,
        pullNumber,
    });
};

export const deleteIntegration = async (
    teamId: string,
    connectionId?: string,
) => {
    return axiosAuthorized.deleted<any>(
        CODE_MANAGEMENT_API_PATHS.DELETE_INTEGRATION,
        { params: { teamId, ...(connectionId ? { connectionId } : {}) } },
    );
};

export const deleteIntegrationAndRepositories = async (
    teamId: string,
    connectionId?: string,
) => {
    return axiosAuthorized.deleted<any>(
        CODE_MANAGEMENT_API_PATHS.DELETE_INTEGRATION_AND_REPOSITORIES,
        { params: { teamId, ...(connectionId ? { connectionId } : {}) } },
    );
};

export const getPrsByRepository = async (
    teamId: string,
    repositoryId: string,
    filters?: {
        number?: string;
        startDate?: string;
        endDate?: string;
        author?: string;
        branch?: string;
        title?: string;
        state?: "open" | "closed" | "merged" | "all";
    },
) => {
    const { data: rawData } = (await axiosAuthorized.fetcher(
        CODE_MANAGEMENT_API_PATHS.GET_PULL_REQUESTS,
        {
            params: {
                teamId,
                repositoryId,
                ...filters,
            },
        },
    )) as {
        data: {
            id: string;
            pull_number: number;
            repository: {
                id: string;
                name: string;
            };
            title: string;
            url: string;
        }[];
    };

    // Transform to legacy format for compatibility
    return rawData.map((pr) => ({
        id: pr.id,
        pull_number: pr.pull_number,
        repository: pr.repository.name, // Extract name from repository object
        repositoryId: pr.repository.id,
        title: pr.title,
        url: pr.url,
    }));
};
