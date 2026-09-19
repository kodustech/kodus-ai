import {
    AuthMode,
    OrganizationAndTeamData,
    PlatformType,
} from "src/core/types";
import { axiosAuthorized } from "src/core/utils/axios";

import {
    CODE_MANAGEMENT_API_PATHS,
    type Repository,
    type RepositoryUploadResult,
} from "./types";

export const getRepositories = async (
    teamId: string,
    organizationSelected?: any,
) => {
    const { data }: { data: any[] } = await axiosAuthorized.fetcher(
        CODE_MANAGEMENT_API_PATHS.GET_REPOSITORIES_ORG,
        { params: { teamId, organizationSelected } },
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
    },
) => {
    return axiosAuthorized.post(
        CODE_MANAGEMENT_API_PATHS.CREATE_OR_UPDATE_REPOSITORIES_CONFIG,
        {
            repositories,
            teamId,
            type,
            ...(options?.deferWebhooks ? { deferWebhooks: true } : {}),
        },
    );
};

export const createOrUpdateRepositoriesInChunks = async (
    repositories: Repository[],
    teamId: string,
    onProgress?: (current: number, total: number) => void,
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
    token = "",
    username = "",
    email = "",
    orgName = "",
}: {
    integrationType: PlatformType;
    organizationAndTeamData: OrganizationAndTeamData;
    authMode?: AuthMode;
    host?: string;
    code?: any;
    installationId?: any;
    token?: string;
    username?: string;
    email?: string;
    orgName?: string;
}) => {
    const authCode = installationId || code;

    if (!token && !authCode) {
        throw new Error(
            "Either installationId or code must be provided when token is not present",
        );
    }
    return axiosAuthorized.post<{
        statusCode: number;
        data: {
            success: boolean;
            status: "SUCCESS" | "NO_ORGANIZATION" | "NO_REPOSITORIES";
        };
    }>(CODE_MANAGEMENT_API_PATHS.CREATE_AUTH_INTEGRATION, {
        code: authCode,
        integrationType,
        organizationAndTeamData,
        authMode,
        token,
        host,
        username,
        email,
        orgName,
    });
};

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

export const deleteIntegration = async (teamId: string) => {
    return axiosAuthorized.deleted<any>(
        CODE_MANAGEMENT_API_PATHS.DELETE_INTEGRATION,
        { params: { teamId } },
    );
};

export const deleteIntegrationAndRepositories = async (teamId: string) => {
    return axiosAuthorized.deleted<any>(
        CODE_MANAGEMENT_API_PATHS.DELETE_INTEGRATION_AND_REPOSITORIES,
        { params: { teamId } },
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
