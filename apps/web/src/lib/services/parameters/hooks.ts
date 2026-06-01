import { CustomMessageConfig } from "@services/pull-request-messages/types";
import { useQuery } from "@tanstack/react-query";
import type {
    AutomationCodeReviewConfigType,
    CodeReviewGlobalConfig,
    FormattedGlobalCodeReviewConfig,
} from "src/app/(app)/settings/code-review/_types";
import { axiosAuthorized } from "src/core/utils/axios";
import {
    generateQueryKey,
    useFetch,
    useSuspenseFetch,
} from "src/core/utils/reactQuery";

import { PARAMETERS_PATHS } from ".";
import { ParametersConfigKey, PlatformConfigValue } from "./types";

type PlatformConfigResponse = {
    uuid: string;
    configKey: ParametersConfigKey.PLATFORM_CONFIGS;
    configValue: PlatformConfigValue;
};

type FormattedCodeReviewParameterResponse = {
    uuid: string;
    configKey: ParametersConfigKey.CODE_REVIEW_CONFIG;
    configValue: FormattedGlobalCodeReviewConfig;
};

type DefaultCodeReviewParameterResponse = CodeReviewGlobalConfig & {
    customMessages: CustomMessageConfig;
};

export const useSuspenseGetParameterPlatformConfigs = (
    teamId: string,
    config?: Parameters<typeof useSuspenseFetch<PlatformConfigResponse>>[2],
) => {
    return useSuspenseFetch<{
        uuid: string;
        configKey: ParametersConfigKey.PLATFORM_CONFIGS;
        configValue: PlatformConfigValue;
    }>(
        PARAMETERS_PATHS.GET_BY_KEY,
        {
            params: {
                teamId,
                key: ParametersConfigKey.PLATFORM_CONFIGS,
            },
        },
        {
            ...config,
            fallbackData: {
                uuid: "",
                configKey: ParametersConfigKey.PLATFORM_CONFIGS,
                configValue: {},
            },
        },
    );
};

export const useSuspenseGetCodeReviewParameter = (teamId: string) => {
    return useSuspenseFetch<{
        uuid: string;
        configKey: ParametersConfigKey.CODE_REVIEW_CONFIG;
        configValue: AutomationCodeReviewConfigType;
    }>(
        PARAMETERS_PATHS.GET_BY_KEY,
        {
            params: {
                key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                teamId,
            },
        },
        {
            fallbackData: {
                uuid: "",
                configKey: ParametersConfigKey.CODE_REVIEW_CONFIG,
                configValue: {
                    repositories: [],
                } as unknown as AutomationCodeReviewConfigType,
            },
        },
    );
};

export const useSuspenseGetFormattedCodeReviewParameter = (teamId: string) => {
    return useSuspenseFetch<{
        uuid: string;
        configKey: ParametersConfigKey.CODE_REVIEW_CONFIG;
        configValue: FormattedGlobalCodeReviewConfig;
    }>(
        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
        {
            params: {
                teamId,
            },
        },
        {
            fallbackData: {
                uuid: "",
                configKey: ParametersConfigKey.CODE_REVIEW_CONFIG,
                configValue: {
                    repositories: [],
                } as unknown as FormattedGlobalCodeReviewConfig,
            },
        },
    );
};

export const useCodeReviewSettingsShell = (
    teamId: string,
    config?: Parameters<
        typeof useFetch<FormattedCodeReviewParameterResponse>
    >[3],
) => {
    return useFetch<FormattedCodeReviewParameterResponse>(
        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
        {
            params: {
                teamId,
            },
        },
        Boolean(teamId),
        {
            ...config,
            placeholderData: config?.placeholderData ?? ((prev) => prev),
        },
    );
};

export const useSuspenseGetDefaultCodeReviewParameter = (
    config?: Parameters<
        typeof useSuspenseFetch<DefaultCodeReviewParameterResponse>
    >[2],
) => {
    return useSuspenseFetch<DefaultCodeReviewParameterResponse>(
        PARAMETERS_PATHS.DEFAULT_CODE_REVIEW_PARAMETER,
        undefined,
        config,
    );
};

export const useGetCodeReviewLabels = (codeReviewVersion?: string) => {
    // Normalize any unknown version (e.g. "v3-agent") to "v2"; only "legacy" is the other valid option
    const normalizedVersion = codeReviewVersion === "legacy" ? "legacy" : "v2";
    const params = {
        params: { codeReviewVersion: normalizedVersion },
    };

    type Label = { type: string; name: string; description: string };

    return useFetch<Array<Label>>(
        PARAMETERS_PATHS.GET_CODE_REVIEW_LABELS,
        params,
        true,
        {
            // Some endpoints return raw arrays; others return { statusCode, data }
            // and now may return { statusCode, data: { labels: [] } }
            select: (value: any): Label[] => {
                if (Array.isArray(value)) return value as Label[];
                const data = value?.data;
                if (Array.isArray(data)) return data as Label[];
                if (Array.isArray(data?.labels)) return data.labels as Label[];
                if (Array.isArray(value?.labels))
                    return value.labels as Label[];
                return [] as Label[];
            },
        },
    );
};

export const useGetAllCodeReviewLabels = () => {
    type Label = { type: string; name: string; description: string };

    const v1Labels = useFetch<Array<Label>>(
        PARAMETERS_PATHS.GET_CODE_REVIEW_LABELS,
        { params: { codeReviewVersion: "legacy" } },
        true,
    );

    const v2Labels = useFetch<Array<Label>>(
        PARAMETERS_PATHS.GET_CODE_REVIEW_LABELS,
        { params: { codeReviewVersion: "v2" } },
        true,
    );

    // Remove duplicates based on type
    const uniqueLabels = new Map<string, Label>();

    const normalizeToArray = (value: unknown): Label[] => {
        if (Array.isArray(value)) return value as Label[];
        const data = (value as any)?.data;
        if (Array.isArray(data)) return data as Label[];
        if (Array.isArray(data?.labels)) return data.labels as Label[];
        if (Array.isArray((value as any)?.labels))
            return (value as any).labels as Label[];
        return [];
    };

    const v1Data = normalizeToArray(v1Labels.data as unknown);
    const v2Data = normalizeToArray(v2Labels.data as unknown);

    [...v1Data, ...v2Data].forEach((label) => {
        if (!uniqueLabels.has(label.type)) uniqueLabels.set(label.type, label);
    });

    return {
        v1: v1Labels,
        v2: v2Labels,
        isLoading: v1Labels.isLoading || v2Labels.isLoading,
        allLabels: Array.from(uniqueLabels.values()),
    };
};

export type CodeReviewV2Defaults = {
    categories: {
        bug: string;
        performance: string;
        security: string;
    };
    severity: {
        critical: string;
        high: string;
        medium: string;
        low: string;
    };
};

export const useSuspenseGetParameterByKey = <T>(
    key: string,
    teamId: string,
    config?: Parameters<
        typeof useSuspenseFetch<{
            uuid: string;
            configKey: string;
            configValue: T;
        }>
    >["2"],
) => {
    return useSuspenseFetch<{
        uuid: string;
        configKey: string;
        configValue: T;
    }>(PARAMETERS_PATHS.GET_BY_KEY, { params: { key, teamId } }, config);
};

export const useOptionalParameterQuery = <T>(
    key: string,
    teamId: string | undefined,
    fallbackData: {
        uuid: string;
        configKey: string;
        configValue: T;
    },
) => {
    return useQuery<{
        uuid: string;
        configKey: string;
        configValue: T;
    }>({
        queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
            params: { key, teamId },
        }),
        enabled: Boolean(teamId),
        placeholderData: (prev) => prev,
        retry: false,
        queryFn: async ({ signal }) => {
            try {
                const payload = (await axiosAuthorized.fetcher<{
                    data?: {
                        uuid: string;
                        configKey: string;
                        configValue: T;
                    };
                }>(PARAMETERS_PATHS.GET_BY_KEY, {
                    params: { key, teamId },
                    signal,
                })) as {
                    data?: {
                        uuid: string;
                        configKey: string;
                        configValue: T;
                    };
                };

                return payload.data ?? fallbackData;
            } catch (error) {
                if (
                    typeof error === "object" &&
                    error !== null &&
                    "response" in error &&
                    (error as { response?: { status?: number } }).response
                        ?.status === 404
                ) {
                    return fallbackData;
                }

                throw error;
            }
        },
    });
};
