import { authorizedFetch } from "@services/fetch";

import { TOKEN_USAGE_PATHS } from ".";
import {
    DailyUsageByDeveloperResultContract,
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    ModelPricingInfo,
    TokenUsageQueryContract,
    UsageByDeveloperResultContract,
    UsageByPrResultContract,
    UsageSummaryContract,
} from "./types";

export const getSummaryTokenUsage = async (
    filters: TokenUsageQueryContract,
) => {
    return await authorizedFetch<UsageSummaryContract>(
        TOKEN_USAGE_PATHS.GET_SUMMARY,
        {
            params: { ...filters },
        },
    );
};

export const getDailyTokenUsage = async (filters: TokenUsageQueryContract) => {
    return await authorizedFetch<DailyUsageResultContract[]>(
        TOKEN_USAGE_PATHS.GET_DAILY,
        {
            params: { ...filters },
        },
    );
};

export const getTokenUsageByPR = async (filters: TokenUsageQueryContract) => {
    return await authorizedFetch<UsageByPrResultContract[]>(
        TOKEN_USAGE_PATHS.GET_BY_PR,
        {
            params: { ...filters },
        },
    );
};

export const getDailyTokenUsageByPR = async (
    filters: TokenUsageQueryContract,
) => {
    return await authorizedFetch<DailyUsageByPrResultContract[]>(
        TOKEN_USAGE_PATHS.GET_DAILY_BY_PR,
        {
            params: { ...filters },
        },
    );
};

export const getTokenUsageByDeveloper = async (
    filters: TokenUsageQueryContract,
) => {
    return await authorizedFetch<UsageByDeveloperResultContract[]>(
        TOKEN_USAGE_PATHS.GET_BY_DEVELOPER,
        {
            params: { ...filters },
        },
    );
};

export const getDailyTokenUsageByDeveloper = async (
    filters: TokenUsageQueryContract,
) => {
    return await authorizedFetch<DailyUsageByDeveloperResultContract[]>(
        TOKEN_USAGE_PATHS.GET_DAILY_BY_DEVELOPER,
        {
            params: { ...filters },
        },
    );
};

export const getTokenPricing = async (model: string, provider?: string) => {
    return await authorizedFetch<ModelPricingInfo>(
        TOKEN_USAGE_PATHS.GET_TOKEN_PRICING,
        {
            params: { provider, model },
        },
    );
};
