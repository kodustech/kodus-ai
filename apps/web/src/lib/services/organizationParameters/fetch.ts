import { authorizedFetch } from "@services/fetch";
import {
    OrganizationParametersConfigKey,
    type CockpitMetricsVisibility,
    type OrganizationParametersAutoAssignConfig,
} from "@services/parameters/types";
import { axiosAuthorized } from "src/core/utils/axios";
import type { BYOKConfig } from "src/features/ee/byok/_types";

import { ORGANIZATION_PARAMETERS_PATHS } from ".";

export const createOrUpdateOrganizationParameter = async (
    key: string,
    configValue: any,
) => {
    return await axiosAuthorized.post<any>(
        ORGANIZATION_PARAMETERS_PATHS.CREATE_OR_UPDATE,
        {
            key,
            configValue,
        },
    );
};

export const getBYOK = async () => {
    const byokConfig = await getOrganizationParameterByKey<{
        configValue: { main: BYOKConfig; fallback: BYOKConfig };
    }>(
        {
            key: OrganizationParametersConfigKey.BYOK_CONFIG,
        },
        {
            cache: "no-store",
        },
    );

    return byokConfig?.configValue;
};

export const getAutoLicenseAssignmentConfig = async () => {
    const config = await getOrganizationParameterByKey<{
        configValue: OrganizationParametersAutoAssignConfig;
    }>({
        key: OrganizationParametersConfigKey.AUTO_LICENSE_ASSIGNMENT,
    });

    return config?.configValue;
};

export const deleteBYOK = async (params: {
    configType: "main" | "fallback";
}) => {
    return await axiosAuthorized.deleted<any>(
        ORGANIZATION_PARAMETERS_PATHS.DELETE_BYOK,
        { params },
    );
};

export type TestBYOKResultCode =
    | "ok"
    | "auth"
    | "not_found"
    | "bad_request"
    | "payment"
    | "rate_limit"
    | "server_error"
    | "network"
    | "unknown";

export type TestBYOKResult = {
    ok: boolean;
    code: TestBYOKResultCode;
    latencyMs: number;
    message?: string;
    providerMessage?: string;
    httpStatus?: number;
};

export const testBYOK = async (params: {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    vertexLocation?: string;
    awsBearerToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    awsSessionToken?: string;
}): Promise<TestBYOKResult> => {
    const envelope = await axiosAuthorized.post<{ data: TestBYOKResult }>(
        ORGANIZATION_PARAMETERS_PATHS.TEST_BYOK,
        params,
    );
    return envelope.data;
};

/**
 * Validate a model id against the org's SAVED BYOK provider (credentials
 * resolved server-side). Truthful "will this model work?" check.
 */
export const testBYOKModel = async (params: {
    provider: string;
    model: string;
}): Promise<TestBYOKResult> => {
    const envelope = await axiosAuthorized.post<{ data: TestBYOKResult }>(
        ORGANIZATION_PARAMETERS_PATHS.TEST_BYOK_MODEL,
        params,
    );
    return envelope.data;
};

export type ModelOverrideEntry = {
    scope: "global" | "repository" | "directory";
    repositoryId?: string;
    repositoryName?: string;
    directoryId?: string;
    directoryName?: string;
    model: string;
    /** null when we can't judge (provider catalog unavailable). */
    inCurrentProviderCatalog: boolean | null;
};

export type ListModelOverridesResult = {
    provider?: string;
    overrides: ModelOverrideEntry[];
    mismatchedCount: number;
};

export type ClearOverrideTarget = {
    repositoryId?: string;
    directoryId?: string;
};

/** List per-repo/dir byokModel overrides + which mismatch the current provider.
 *  Overrides live in the TEAM-scoped code-review config, so a teamId is
 *  required to find them. */
export const listModelOverrides = async (
    teamId: string,
): Promise<ListModelOverridesResult> => {
    const result = await authorizedFetch<ListModelOverridesResult>(
        ORGANIZATION_PARAMETERS_PATHS.MODEL_OVERRIDES,
        { cache: "no-store", params: { teamId } },
    );
    return result ?? { overrides: [], mismatchedCount: 0 };
};

/** Bulk-clear byokModel overrides at the given targets (set to inherit). */
export const clearModelOverrides = async (
    teamId: string,
    targets: ClearOverrideTarget[],
): Promise<{ clearedCount: number }> => {
    const envelope = await axiosAuthorized.post<{
        data: { clearedCount: number };
    }>(ORGANIZATION_PARAMETERS_PATHS.MODEL_OVERRIDES_CLEAR, { teamId, targets });
    return envelope.data;
};

export type LLMConfigSource = "byok" | "env" | "none";

export type LLMConfigStatus = {
    source: LLMConfigSource;
    byok: {
        configured: boolean;
        model?: string;
        providerId?: string;
        baseUrl?: string;
    };
    env: {
        configured: boolean;
        model?: string;
        providerId?:
            | "openai"
            | "openai_compatible"
            | "anthropic"
            | "google_gemini"
            | "google_vertex";
        baseUrl?: string;
        vertexLocation?: string;
    };
};

export const getLLMConfigStatus = async (): Promise<LLMConfigStatus> => {
    return await authorizedFetch<LLMConfigStatus>(
        ORGANIZATION_PARAMETERS_PATHS.GET_LLM_CONFIG_STATUS,
        { cache: "no-store" },
    );
};

export type LLMProviderModel = { id: string; name: string };

export const getLLMProviderModels = async (
    provider: string,
): Promise<LLMProviderModel[]> => {
    const response = await authorizedFetch<{ models: LLMProviderModel[] }>(
        ORGANIZATION_PARAMETERS_PATHS.GET_PROVIDER_MODELS_LIST,
        { cache: "no-store", params: { provider } },
    );
    return response?.models ?? [];
};

export const getOrganizationParameterByKey = async <
    T extends { configValue: unknown },
>(
    params: {
        key: OrganizationParametersConfigKey;
    },
    config?: Parameters<typeof authorizedFetch<T | null>>[1],
) =>
    await authorizedFetch<T | null>(ORGANIZATION_PARAMETERS_PATHS.GET_BY_KEY, {
        ...config,
        params,
    });

const DEFAULT_COCKPIT_METRICS_VISIBILITY: CockpitMetricsVisibility = {
    tabs: {
        kodusReview: true,
        productivity: true,
    },
    summary: {
        deployFrequency: true,
        prCycleTime: true,
        kodySuggestions: true,
        bugRatio: true,
        prSize: true,
    },
    details: {
        leadTimeBreakdown: true,
        prCycleTime: true,
        prsOpenedVsClosed: true,
        prsMergedByDeveloper: true,
        teamActivity: true,
    },
};

export const getCockpitMetricsVisibility =
    async (): Promise<CockpitMetricsVisibility> => {
        const response = await authorizedFetch<CockpitMetricsVisibility>(
            ORGANIZATION_PARAMETERS_PATHS.GET_COCKPIT_METRICS_VISIBILITY,
        );

        return response ?? DEFAULT_COCKPIT_METRICS_VISIBILITY;
    };

export const updateCockpitMetricsVisibility = async (params: {
    teamId?: string;
    config: CockpitMetricsVisibility;
}) => {
    return await axiosAuthorized.post(
        ORGANIZATION_PARAMETERS_PATHS.UPDATE_COCKPIT_METRICS_VISIBILITY,
        params,
    );
};

export const updateAutoLicenseAllowedUsers = async (params: {
    organizationId?: string;
    teamId?: string;
    includeCurrentUser?: boolean;
}) => {
    return await axiosAuthorized.post(
        ORGANIZATION_PARAMETERS_PATHS.UPDATE_AUTO_LICENSE_ALLOWED_USERS,
        params,
    );
};
