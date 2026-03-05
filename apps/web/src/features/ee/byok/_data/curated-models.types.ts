export type ModelTier = "recommended" | "bestValue" | "budget" | "other";
export type SpeedRating = "fast" | "medium" | "slow";
export type CostTier = "$" | "$$" | "$$$";
export type BadgeType = "tested" | "untested" | "legacy";

export type CuratedModel = {
    id: string;
    displayName: string;
    provider: string;
    tier: ModelTier;
    benchmarkScore: number;
    description: string;
    speed: SpeedRating;
    contextWindow: string;
    costTier: CostTier;
    strengths: string[];
    weaknesses: string[];
    apiKeyUrl: string;
    defaults: {
        temperature: number;
        maxOutputTokens: number;
    };
};

export type ModelAnnotation = {
    badge: BadgeType;
    note: string;
};

export type CuratedModelsCatalog = {
    version: string;
    lastUpdated: string;
    models: CuratedModel[];
    annotations: Record<string, Record<string, ModelAnnotation>>;
};

/**
 * Matches a model ID against an annotation pattern that supports trailing wildcards.
 * E.g., "claude-sonnet-4-5*" matches "claude-sonnet-4-5-20250929".
 */
function matchesPattern(pattern: string, modelId: string): boolean {
    if (pattern.endsWith("*")) {
        return modelId.startsWith(pattern.slice(0, -1));
    }
    return modelId === pattern;
}

/**
 * Looks up annotation for a given provider and model ID using glob-like pattern matching.
 */
export function getAnnotationForModel(
    annotations: CuratedModelsCatalog["annotations"],
    provider: string,
    modelId: string,
): ModelAnnotation | undefined {
    const providerAnnotations = annotations[provider];
    if (!providerAnnotations) return undefined;

    let bestMatch: { pattern: string; annotation: ModelAnnotation } | undefined;

    for (const [pattern, annotation] of Object.entries(providerAnnotations)) {
        if (matchesPattern(pattern, modelId)) {
            if (!bestMatch || pattern.length > bestMatch.pattern.length) {
                bestMatch = { pattern, annotation };
            }
        }
    }

    return bestMatch?.annotation;
}
