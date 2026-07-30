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
    UsageByReviewResultContract,
    UsageOverviewReportContract,
    UsageSummaryContract,
} from "./types";

/**
 * Single-request overview: summary (totals + cost + per-model) + daily + by-PR
 * from one covered aggregation. Replaces the separate summary/daily/by-pr
 * fetches the screen used to fire in parallel.
 */
export const getTokenUsageOverview = async (
    filters: TokenUsageQueryContract,
) => {
    return await authorizedFetch<UsageOverviewReportContract>(
        TOKEN_USAGE_PATHS.GET_OVERVIEW,
        {
            params: { ...filters },
        },
    );
};

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

export const getTokenUsageByReview = async (
    filters: TokenUsageQueryContract,
) => {
    return await authorizedFetch<UsageByReviewResultContract[]>(
        TOKEN_USAGE_PATHS.GET_BY_REVIEW,
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

/**
 * Batch pricing: one request for many models (LiteLLM catalog fetched once
 * server-side). Returns a `{ [model]: ModelPricingInfo }` map. Replaces the
 * per-model N+1 the page used to fire.
 */
export const getTokenPricingBatch = async (
    models: string[],
    provider?: string,
) => {
    return await authorizedFetch<Record<string, ModelPricingInfo>>(
        TOKEN_USAGE_PATHS.GET_TOKEN_PRICING_BATCH,
        {
            params: { provider, models: models.join(",") },
        },
    );
};
