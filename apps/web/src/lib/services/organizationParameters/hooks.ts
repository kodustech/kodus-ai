import {
    OrganizationParametersConfigKey,
    Timezone,
} from "@services/parameters/types";
import { useFetch, useSuspenseFetch } from "src/core/utils/reactQuery";
import type { BYOKConfig } from "src/features/ee/byok/_types";

import { ORGANIZATION_PARAMETERS_PATHS } from ".";

export function useSuspenseGetLLMProviders() {
    return useSuspenseFetch<{
        providers: Array<{
            id: string;
            name: string;
            requiresApiKey: boolean;
            requiresBaseUrl: boolean;
            autoListModels: boolean;
        }>;
    }>(ORGANIZATION_PARAMETERS_PATHS.GET_PROVIDERS_LIST);
}

export function useSuspenseGetLLMProviderModels({
    provider,
}: {
    provider: string;
}) {
    return useSuspenseFetch<{ models: Array<{ id: string; name: string }> }>(
        ORGANIZATION_PARAMETERS_PATHS.GET_PROVIDER_MODELS_LIST,
        { params: { provider } },
    );
}

export function useGetTimezone() {
    const result = useFetch<{ configValue: Timezone } | null>(
        ORGANIZATION_PARAMETERS_PATHS.GET_BY_KEY,
        {
            params: {
                key: OrganizationParametersConfigKey.TIMEZONE_CONFIG,
            },
        },
        true,
        { staleTime: 1000 * 60 * 60 },
    );

    return result.data?.configValue ?? null;
}

export function useSuspenseGetBYOK() {
    return useSuspenseFetch<{
        configValue: BYOKConfig;
    } | null>(
        ORGANIZATION_PARAMETERS_PATHS.GET_BY_KEY,
        {
            params: {
                key: OrganizationParametersConfigKey.BYOK_CONFIG,
            },
        },
        {
            fallbackData: null,
        },
    );
}
