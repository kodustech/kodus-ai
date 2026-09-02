// @ts-nocheck
import { authorizedFetch } from '@services/fetch';
import {
    OrganizationParametersConfigKey,
    type CockpitMetricsVisibility,
    type OrganizationParametersAutoAssignConfig,
} from '@services/parameters/types';
import { axiosAuthorized } from 'src/core/utils/axios';
import type { BYOKConfig } from 'src/features/ee/byok/_types';

import { ORGANIZATION_PARAMETERS_PATHS } from '.';

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

export const getBYOK = async (): Promise<BYOKConfig | undefined> => {
    // find-by-key returns the RAW v2 blob run through maskV2ConfigSecrets, so
    // every secret is already `••••` — no new endpoint is needed (open item #5).
    const byokConfig = await getOrganizationParameterByKey<{
        configValue: BYOKConfig;
    }>(
        {
            key: OrganizationParametersConfigKey.BYOK_CONFIG,
        },
        {
            cache: 'no-store',
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

export const deleteBYOK = async (params: { modelId: string }) => {
    // v2 delete targets a single model slot by id (DELETE
    // /delete-byok-config?modelId=), replacing the legacy { configType }.
    return await axiosAuthorized.deleted<any>(
        ORGANIZATION_PARAMETERS_PATHS.DELETE_BYOK,
        { params },
    );
};

export type TestBYOKResultCode =
    | 'ok'
    | 'auth'
    | 'not_found'
    | 'bad_request'
    | 'payment'
    | 'rate_limit'
    | 'server_error'
    | 'network'
    | 'unknown';

export type TestBYOKResult = {
    ok: boolean;
    code: TestBYOKResultCode;
    latencyMs: number;
    message?: string;
    providerMessage?: string;
    httpStatus?: number;
    /** Set on a PASSING test whose Custom reasoning override the provider's
     *  adapter ignored. The connection works; the config is not doing what was
     *  pasted. Advisory — never blocks saving. */
    warning?: string;
};

export const testBYOK = async (params: {
    provider: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
    // The configured tuning — validated server-side against the model's rules
    // and exercised on the real chat probe, so a mismatch (e.g. a temperature an
    // always-thinking model won't honor) fails the Test instead of saving quiet.
    temperature?: number;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
    // The rest of what the save will persist. Sent so the probe exercises the
    // exact slot being saved — a raw reasoning override with the wrong shape, or
    // an OpenRouter pin no upstream can serve, used to save clean and only fail
    // on the first review.
    reasoningConfigOverride?: string;
    maxOutputTokens?: number;
    openrouterProviderOrder?: string[];
    openrouterAllowFallbacks?: boolean;
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
    // SAFE non-secret overrides (region/location) — so editing them without
    // re-typing the secret probes the config being saved, not the stored one.
    // baseURL is NOT accepted: the server must not send the stored secret to a
    // caller-supplied host. Changing the endpoint requires re-entering the key.
    awsRegion?: string;
    vertexLocation?: string;
}): Promise<TestBYOKResult> => {
    const envelope = await axiosAuthorized.post<{ data: TestBYOKResult }>(
        ORGANIZATION_PARAMETERS_PATHS.TEST_BYOK_MODEL,
        params,
    );
    return envelope.data;
};

export type ModelOverrideEntry = {
    scope: 'global' | 'repository' | 'directory';
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
        { cache: 'no-store', params: { teamId } },
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
    }>(ORGANIZATION_PARAMETERS_PATHS.MODEL_OVERRIDES_CLEAR, {
        teamId,
        targets,
    });
    return envelope.data;
};

export type LLMConfigSource = 'byok' | 'env' | 'none';

/**
 * One enumerated v2 model in the per-org status. Web mirror of the backend
 * LLMModelStatus (get-llm-config-status.use-case.ts) — METADATA ONLY, every
 * secret masked. `capabilities` is a static descriptor (04-10) used by the
 * Routing tab's LIVE capability gate; absent for an unknown provider.
 */
export type LLMModelStatus = {
    modelId: string;
    model?: string;
    providerId?: string;
    baseUrl?: string;
    resolvable: boolean;
    capabilities?: { structuredOutput?: string; toolCalling?: string };
};

export type LLMConfigStatus = {
    source: LLMConfigSource;
    /** Per-org enumeration of the configured v2 models[] (empty for non-v2). */
    models: LLMModelStatus[];
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
            | 'openai'
            | 'openai_compatible'
            | 'anthropic'
            | 'google_gemini'
            | 'google_vertex';
        baseUrl?: string;
        vertexLocation?: string;
    };
};

export const getLLMConfigStatus = async (): Promise<LLMConfigStatus> => {
    return await authorizedFetch<LLMConfigStatus>(
        ORGANIZATION_PARAMETERS_PATHS.GET_LLM_CONFIG_STATUS,
        { cache: 'no-store' },
    );
};

/**
 * One connectable BYOK provider from the backend registry (single source of
 * truth for the provider LIST). Web mirror of the backend ByokProviderDescriptor
 * (get-byok-providers.use-case.ts). STATIC + non-sensitive — never a secret.
 */
export type ByokProviderDescriptor = {
    id: string;
    label: string;
    aliases: string[];
    /** Whether the provider's models can be enumerated (vs. custom-endpoint /
     *  manual). Drives the picker subtitle. */
    autoListModels: boolean;
    /** Provider docs URL (hardcoded on the module). UI fallback when a curated
     *  model has no docsUrl. */
    doc?: string;
};

/**
 * List the registry-driven connectable BYOK providers. Mirrors
 * getLLMConfigStatus's proxy fetch. Returns [] on absence so callers can fall
 * back to the curated-derived list (never an empty picker).
 */
export const listByokProviders = async (): Promise<
    ByokProviderDescriptor[]
> => {
    const response = await authorizedFetch<{
        providers: ByokProviderDescriptor[];
    }>(ORGANIZATION_PARAMETERS_PATHS.GET_BYOK_PROVIDERS, {
        cache: 'no-store',
    });
    return response?.providers ?? [];
};

export type LLMProviderModel = { id: string; name: string };

export const getLLMProviderModels = async (
    provider: string,
): Promise<LLMProviderModel[]> => {
    const response = await authorizedFetch<{ models: LLMProviderModel[] }>(
        ORGANIZATION_PARAMETERS_PATHS.GET_PROVIDER_MODELS_LIST,
        { cache: 'no-store', params: { provider } },
    );
    return response?.models ?? [];
};

/**
 * Live-list a provider's models using a JUST-TYPED, unsaved credential — for the
 * connect form, before the key is persisted. POST so the key rides in the body
 * (never a query string). Server prefers this key over the saved slot and is
 * strict for http providers (a bad key surfaces an error, not a curated stand-in).
 */
export const previewLLMProviderModels = async (input: {
    provider: string;
    apiKey?: string;
    baseURL?: string;
}): Promise<LLMProviderModel[]> => {
    const envelope = await axiosAuthorized.post<{
        data: { models: LLMProviderModel[] };
    }>(ORGANIZATION_PARAMETERS_PATHS.GET_PROVIDER_MODELS_LIST, input);
    return envelope.data?.models ?? [];
};

/** Per-model UI capability hints, read from the provider module server-side
 *  (temperature/reasoning support). `model` is a plain id, not a secret, so a
 *  GET with query params is fine. */
/** How the Temperature field behaves — the web-local mirror of the backend
 *  `TemperaturePolicy` (kept as its own copy so apps/web doesn't import a value
 *  from `@libs/*`, which breaks the isolated prod build). `adjustable` = editable,
 *  `unsupported` = hidden, `fixed` = locked to `value`. */
export type TemperaturePolicy =
    | { kind: 'adjustable' }
    | { kind: 'unsupported' }
    | { kind: 'fixed'; value: number };

export type ModelUiCapabilities = {
    temperature: TemperaturePolicy;
    /** Applies only when reasoning is off, and only when it differs from
     *  `temperature`. Ships in the same response so the endpoint stays a pure
     *  function of (provider, model) and the toggle never refetches. */
    temperatureWhenReasoningOff?: TemperaturePolicy;
    supportsReasoning: boolean;
    reasoningOptions: Array<'low' | 'medium' | 'high'>;
    /** Provider-owned example for the "Custom" reasoning-override textarea. */
    reasoningOverrideExample?: string;
};

export const getModelCapabilities = async (input: {
    provider: string;
    model: string;
}): Promise<ModelUiCapabilities> => {
    const response = await authorizedFetch<ModelUiCapabilities>(
        ORGANIZATION_PARAMETERS_PATHS.GET_MODEL_CAPABILITIES,
        { cache: 'no-store', params: input },
    );
    return (
        response ?? {
            temperature: { kind: 'adjustable' },
            supportsReasoning: false,
            reasoningOptions: [],
        }
    );
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
