import { getModelCapabilities } from './capabilities';
import type { ModelCapabilities, ReasoningConfig } from './modelTypes';

export interface UserOptionsLite {
    temperature?: number;
    maxTokens?: number;
    maxReasoningTokens?: number;
    jsonMode?: boolean;
    reasoningLevel?: 'low' | 'medium' | 'high';
}

export interface ResolvedModelOptions {
    model: string;
    temperature?: number;
    resolvedMaxTokens?: number;
    resolvedReasoningTokens?: number;
    supportsTemperature: boolean;
    supportsReasoning: boolean;
    reasoningType?: 'level' | 'budget' | 'adaptive';
    resolvedReasoningLevel?: 'low' | 'medium' | 'high';
}

export function resolveModelOptions(
    model: string,
    user: UserOptionsLite = {},
): ResolvedModelOptions {
    const FALLBACK_BUDGET = 3000;
    const FALLBACK_LEVEL: 'low' | 'medium' | 'high' = 'low';

    const getCaps =
        typeof getModelCapabilities === 'function'
            ? (getModelCapabilities as (m: string) => ModelCapabilities)
            : () => {
                  throw new Error('getModelCapabilities is not a function');
              };
    const caps = getCaps(model);

    const providedMax =
        typeof user.maxTokens === 'number' ? user.maxTokens : -1;
    const resolvedMaxTokens =
        providedMax > 0
            ? providedMax
            : typeof caps.defaultMaxTokens === 'number' &&
                caps.defaultMaxTokens > 0
              ? caps.defaultMaxTokens
              : undefined;

    let resolvedReasoningTokens: number | undefined;
    let resolvedReasoningLevel: 'low' | 'medium' | 'high' | undefined;
    const rc: ReasoningConfig | undefined = caps.reasoningConfig;
    if (rc?.type === 'budget') {
        const userReasoning =
            typeof user.maxReasoningTokens === 'number' &&
            user.maxReasoningTokens > 0
                ? user.maxReasoningTokens
                : undefined;
        const defaultReasoning = rc.options.default ?? FALLBACK_BUDGET;
        const minBudget = rc.options.min;
        const maxBudget = rc.options.max;
        const chosenBudget = userReasoning ?? defaultReasoning;
        const boundedBudget = Math.max(
            minBudget,
            typeof chosenBudget === 'number' ? chosenBudget : minBudget,
        );
        resolvedReasoningTokens =
            typeof maxBudget === 'number'
                ? Math.min(maxBudget, boundedBudget)
                : boundedBudget;
    } else if (rc?.type === 'level' || rc?.type === 'adaptive') {
        const allowedLevels = rc.options;
        const desiredLevel = user.reasoningLevel ?? FALLBACK_LEVEL;

        if (allowedLevels.includes(desiredLevel)) {
            resolvedReasoningLevel = desiredLevel;
        } else if (allowedLevels.length > 0) {
            // If desired level isn't supported, use the first available one (e.g. 'medium' for GPT-5)
            resolvedReasoningLevel = allowedLevels[0];
        } else {
            resolvedReasoningLevel = FALLBACK_LEVEL;
        }
    }

    const temperature = caps.supportsTemperature ? user.temperature : undefined;

    const reasoningType: 'level' | 'budget' | 'adaptive' | undefined = rc?.type;

    return {
        model,
        temperature,
        resolvedMaxTokens,
        resolvedReasoningTokens,
        supportsTemperature: caps.supportsTemperature,
        supportsReasoning: caps.supportsReasoning,
        reasoningType,
        resolvedReasoningLevel,
    };
}
