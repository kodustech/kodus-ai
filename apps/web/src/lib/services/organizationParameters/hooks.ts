import {
    OrganizationParametersConfigKey,
    Timezone,
} from '@services/parameters/types';
import { useQuery } from '@tanstack/react-query';
import { useFetch, useSuspenseFetch } from 'src/core/utils/reactQuery';
import type { BYOKConfig } from 'src/features/ee/byok/_types';

import { ORGANIZATION_PARAMETERS_PATHS } from '.';
import {
    getModelCapabilities,
    previewLLMProviderModels,
    type ModelUiCapabilities,
} from './fetch';

export function useSuspenseGetLLMProviders() {
    return useSuspenseFetch<{
        providers: Array<{
            id: string;
            name: string;
            requiresApiKey: boolean;
            requiresBaseUrl: boolean;
            autoListModels: boolean;
            /** Provider lists models via a live `/models` call (needs the key). */
            listsModelsLive: boolean;
            doc?: string;
        }>;
    }>(ORGANIZATION_PARAMETERS_PATHS.GET_PROVIDERS_LIST);
}

/**
 * Live model list for the connect form, fetched with a JUST-TYPED key (POST, key
 * in the body). Non-suspense so the picker can show its own loading/error inline.
 * `enabled` gates it to when we can actually list: a typed key, or an already
 * stored credential (the server lists live from the saved slot with no typed key).
 */
export function useLLMProviderModelsPreview({
    provider,
    apiKey,
    baseURL,
    enabled,
}: {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    enabled: boolean;
}) {
    return useQuery({
        // Key includes apiKey/baseURL so a rotated key refetches; the value never
        // leaves the browser's query cache (client-only, no SSR data cache).
        queryKey: ['byok-provider-models-preview', provider, apiKey, baseURL],
        queryFn: () => previewLLMProviderModels({ provider, apiKey, baseURL }),
        enabled,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
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

/**
 * Per-model UI capabilities (temperature / reasoning support), read from the
 * provider module server-side. Non-suspense + `enabled` so the connect form can
 * render optimistically (default-permissive) while it loads, then refine once the
 * provider's answer arrives. Keyed on provider+model so switching model refetches.
 */
export function useModelCapabilities({
    provider,
    model,
    enabled,
}: {
    provider?: string;
    model?: string;
    enabled: boolean;
}) {
    return useQuery<ModelUiCapabilities>({
        // Keyed on provider+model ONLY. The answer is a pure function of those
        // two, including the parts that vary with the reasoning toggle — those
        // ship as an extra field in the same response, so flipping the toggle
        // never refetches and never invalidates this entry.
        queryKey: ['byok-model-capabilities', provider, model],
        queryFn: () =>
            getModelCapabilities({
                provider: provider ?? '',
                model: model ?? '',
            }),
        enabled: enabled && !!provider,
        staleTime: 10 * 60 * 1000,
        retry: false,
    });
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
