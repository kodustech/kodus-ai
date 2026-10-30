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

export const getFormattedCodeReviewParameterNoCache = async (
    teamId: string,
    options?: { includeFileOverlay?: boolean; signal?: AbortSignal },
) =>
    authorizedFetch<{
        uuid: string;
        configKey: string;
        configValue: FormattedGlobalCodeReviewConfig;
    }>(PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER, {
        params: {
            teamId,
            // Omitted unless explicitly disabled: the API defaults to true and
            // every other caller wants the overlay.
            ...(options?.includeFileOverlay === false
                ? { includeFileOverlay: false }
                : {}),
        },
        cache: "no-store",
        signal: options?.signal,
    });

export const getDefaultCodeReviewParameterNoCache = async (options?: {
    signal?: AbortSignal;
}) =>
    authorizedFetch<
        CodeReviewGlobalConfig & {
            customMessages: CustomMessageConfig;
        }
    >(PARAMETERS_PATHS.DEFAULT_CODE_REVIEW_PARAMETER, {
        cache: "no-store",
        signal: options?.signal,
    });

export const getPlatformConfigParameterNoCache = async (
    teamId: string,
    options?: { signal?: AbortSignal },
) =>
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
        signal: options?.signal,
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
    options?: {
        /** Revisions of the custom agents lists the save was made from. */
        expectedRevisions?: { customAgents?: string; knowledge?: string };
    },
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
                expectedRevisions: options?.expectedRevisions,
            },
        );

        return response.data;
    } catch (error: any) {
        return {
            error: error.response?.status || "Erro desconhecido",
            // What the server refused, e.g. which agent field is too long.
            messages: error.response?.data?.message,
        };
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

/**
 * Preview-env secrets vault (alpha). `secrets` is a flat NAME->value map; an
 * empty value REMOVES a key, omitted keys are kept. The API stores values
 * encrypted and returns only the set of configured NAMES.
 */
export const setEnvironmentSecrets = async (
    teamId: string,
    repositoryId: string,
    secrets: Record<string, string>,
) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.SET_ENVIRONMENT_SECRETS,
            {
                organizationAndTeamData: { teamId },
                repositoryId,
                secrets,
            },
        );

        return response.data as { configured: string[] };
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};

export type EnvironmentInfraStatus = {
    provider: "hetzner";
    region?: string;
    serverType?: string;
    tokenConfigured: boolean;
};

export type RuntimeRunCommand = {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
};
export type RuntimeRunTurn = {
    turn: number;
    reasoning: string;
    commands: RuntimeRunCommand[];
};
export type RuntimeRunRecord = {
    runId?: string;
    ran: boolean;
    ok: boolean;
    scope: string;
    phases: Array<{ phase: string; command: string; exitCode: number; outputTail: string }>;
    serviceLog?: string;
    transcript: RuntimeRunTurn[];
    summary: string;
    findingsCount: number;
    turns: number;
    model?: string;
    startedAt?: string;
    finishedAt?: string;
};

export type GeneratedPlaybook = {
    success: boolean;
    summary: string;
    playbookYaml: string | null;
    config: {
        setup?: string[];
        build?: string[];
        services?: string[];
        test?: string[];
        healthcheck?: string[];
        requiredEnv?: string[];
    } | null;
    requiredEnv: string[];
    verified: boolean;
    error?: string;
};
export type RuntimePlaybookDraft = {
    status: "running" | "done" | "error" | "not_found";
    result: GeneratedPlaybook | null;
};

/**
 * Kick off the async "Generate config" job (detect agent boots a VM + drafts the
 * playbook). Returns a draftId to poll with getRuntimePlaybookDraft.
 */
export const generateRuntimePlaybook = async (params: {
    teamId: string;
    repositoryId: string;
    branch?: string;
}) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.GENERATE_RUNTIME_PLAYBOOK,
            {
                organizationAndTeamData: { teamId: params.teamId },
                repositoryId: params.repositoryId,
                branch: params.branch,
            },
        );
        return response.data as { draftId: string; status: string };
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};

/** Poll a Generate-config job by draftId. */
export const getRuntimePlaybookDraft = async (draftId: string) => {
    try {
        const response = await axiosAuthorized.fetcher<RuntimePlaybookDraft>(
            `${PARAMETERS_PATHS.GENERATE_RUNTIME_PLAYBOOK}/${encodeURIComponent(draftId)}`,
        );
        return response as RuntimePlaybookDraft;
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" } as any;
    }
};

/** The full redacted record for the run viewer (transcript + logs). */
export const getRuntimeRun = async (runId: string) => {
    try {
        const response = await axiosAuthorized.fetcher<RuntimeRunRecord>(
            `${PARAMETERS_PATHS.GET_RUNTIME_RUN}/${encodeURIComponent(runId)}`,
        );
        return response as RuntimeRunRecord | null;
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};

/**
 * Preview-env infrastructure (org-level BYO-cloud, advanced/self-hosted).
 * `token`: `''` removes, omitted keeps the stored one; never returned.
 */
export const setEnvironmentInfra = async (
    teamId: string,
    infra: {
        provider: "hetzner";
        token?: string;
        region?: string;
        serverType?: string;
    },
) => {
    try {
        const response = await axiosAuthorized.post<any>(
            PARAMETERS_PATHS.SET_ENVIRONMENT_INFRA,
            { organizationAndTeamData: { teamId }, ...infra },
        );

        return response.data as EnvironmentInfraStatus;
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};

export const getEnvironmentInfraStatus = async (teamId: string) => {
    try {
        const response = await axiosAuthorized.fetcher<EnvironmentInfraStatus>(
            PARAMETERS_PATHS.GET_ENVIRONMENT_INFRA_STATUS,
            { params: { teamId } },
        );

        return response as EnvironmentInfraStatus | null;
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};

/** Names (never values) of the secrets configured for a repo. */
export const getEnvironmentSecretsStatus = async (
    teamId: string,
    repositoryId: string,
) => {
    try {
        const response = await axiosAuthorized.fetcher<{
            configured: string[];
        }>(PARAMETERS_PATHS.GET_ENVIRONMENT_SECRETS_STATUS, {
            params: { teamId, repositoryId },
        });

        return response as { configured: string[] };
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
