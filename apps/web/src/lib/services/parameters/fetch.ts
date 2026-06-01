import { authorizedFetch } from "@services/fetch";
import type { CustomMessageConfig } from "@services/pull-request-messages/types";
import type {
    CodeReviewGlobalConfig,
    FormattedGlobalCodeReviewConfig,
} from "src/app/(app)/settings/code-review/_types";
import type { LiteralUnion } from "src/core/types";
import { axiosAuthorized } from "src/core/utils/axios";
import { codeReviewConfigRemovePropertiesNotInType } from "src/core/utils/helpers";

import { PARAMETERS_PATHS } from ".";
import { ParametersConfigKey, type PlatformConfigValue } from "./types";

export const getTeamParameters = async <
    T extends { configValue: unknown },
>(params: {
    key: ParametersConfigKey;
    teamId: string;
}) =>
    authorizedFetch<T>(PARAMETERS_PATHS.GET_BY_KEY, {
        params,
        next: { tags: ["team-dependent"] },
    });

export const getTeamParametersNoCache = async <
    T extends { configValue: unknown },
>(params: {
    key: ParametersConfigKey;
    teamId: string;
}) =>
    authorizedFetch<T>(PARAMETERS_PATHS.GET_BY_KEY, {
        params,
        cache: "no-store",
    });

export const getFormattedCodeReviewParameterNoCache = async (teamId: string) =>
    authorizedFetch<{
        uuid: string;
        configKey: string;
        configValue: FormattedGlobalCodeReviewConfig;
    }>(PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER, {
        params: { teamId },
        cache: "no-store",
    });

export const getDefaultCodeReviewParameterNoCache = async () =>
    authorizedFetch<
        CodeReviewGlobalConfig & {
            customMessages: CustomMessageConfig;
        }
    >(PARAMETERS_PATHS.DEFAULT_CODE_REVIEW_PARAMETER, {
        cache: "no-store",
    });

export const getPlatformConfigParameterNoCache = async (teamId: string) =>
    authorizedFetch<{
        uuid: string;
        configKey: ParametersConfigKey.PLATFORM_CONFIGS;
        configValue: PlatformConfigValue;
    }>(PARAMETERS_PATHS.GET_BY_KEY, {
        params: {
            teamId,
            key: ParametersConfigKey.PLATFORM_CONFIGS,
        },
        cache: "no-store",
    });

export const getParameterByKey = async (key: string, teamId: string) => {
    try {
        const response = await axiosAuthorized.fetcher(
            PARAMETERS_PATHS.GET_BY_KEY,
            { params: { key, teamId } },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const createOrUpdateParameter = async (
    key: string,
    configValue: any,
    teamId: string,
) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.CREATE_OR_UPDATE,
            {
                key,
                configValue,
                organizationAndTeamData: { teamId },
            },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const createOrUpdateCodeReviewParameter = async (
    configValue: Partial<CodeReviewGlobalConfig>,
    teamId: string,
    repositoryId: LiteralUnion<"global"> | undefined,
    directoryId?: string,
    directoryPaths?: string[],
) => {
    try {
        const trimmedCodeReviewConfigValue =
            codeReviewConfigRemovePropertiesNotInType(configValue);

        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.CREATE_OR_UPDATE_CODE_REVIEW_PARAMETER,
            {
                configValue: trimmedCodeReviewConfigValue,
                organizationAndTeamData: { teamId },
                repositoryId:
                    repositoryId === "global" ? undefined : repositoryId,
                directoryId,
                directoryPaths,
            },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const updateCodeReviewParameterRepositories = async (teamId: string) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.UPDATE_CODE_REVIEW_PARAMETER_REPOSITORIES,
            { organizationAndTeamData: { teamId } },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const getGenerateKodusConfigFile = async (
    teamId: string,
    repositoryId?: string,
    directoryId?: string,
) => {
    try {
        const response = await axiosAuthorized.fetcher<any>(
            PARAMETERS_PATHS.GENERATE_KODUS_CONFIG_FILE,
            { params: { teamId, repositoryId, directoryId } },
        );

        return response;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const deleteRepositoryCodeReviewParameter = async ({
    repositoryId,
    teamId,
    directoryId,
    folderId,
}: {
    teamId: string;
    repositoryId: string;
    directoryId?: string;
    folderId?: string;
}) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.DELETE_REPOSITORY_CODE_REVIEW_PARAMETER,
            { teamId, repositoryId, directoryId, folderId },
        );

        return response.data;
    } catch (error: any) {
        throw error; // Re-throw to be caught in the modal
    }
};

export const applyCodeReviewPreset = async (params: {
    teamId: string;
    preset: "speed" | "safety" | "coach";
}) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.APPLY_CODE_REVIEW_PRESET,
            params,
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const centralizedConfigSync = async (teamId: string) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.CENTRALIZED_CONFIG_SYNC,
            { teamId },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};

export const centralizedConfigInit = async (body: {
    teamId: string;
    repository: { id: string; name: string };
    syncOption: "pr" | "manual";
}) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.CENTRALIZED_CONFIG_INIT,
            body,
        );

        return response.data as {
            success: boolean;
            message: string;
            prUrl?: string;
        };
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};

export const centralizedConfigDownload = async (teamId: string) => {
    try {
        const data = await axiosAuthorized.fetcher<Blob>(
            PARAMETERS_PATHS.CENTRALIZED_CONFIG_DOWNLOAD,
            { params: { teamId }, responseType: "blob" },
        );

        return data;
    } catch (error) {
        throw error;
    }
};
