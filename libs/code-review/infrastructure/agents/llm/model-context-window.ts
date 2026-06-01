import modelData from './model-context-windows.json';

const MODELS = modelData as Record<
    string,
    { max_input_tokens: number; litellm_provider?: string }
>;

/** Conservative default when the model is unknown. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Manual overrides for models we care about — takes precedence over LiteLLM.
 * Keys are matched against the normalized model name (see `normalize()`).
 * Use this when:
 *   - LiteLLM doesn't have the model yet (newly released)
 *   - LiteLLM's fuzzy match picks a wrong entry
 *   - A provider uses a custom model alias
 */
const MANUAL_OVERRIDES: Record<string, number> = {
    // OpenAI
    'gpt54': 1_000_000,
    'gpt54mini': 272_000,
    'gpt5': 400_000,
    'gpt5mini': 400_000,
    'gptoss': 131_072,
    'gptoss120b': 131_072,
    // Anthropic
    'claudesonnet45': 200_000,
    'claudeopus45': 200_000,
    'claudeopus4': 200_000,
    'claudesonnet4': 200_000,
    // Google
    'gemini31pro': 1_048_576,
    'gemini3pro': 1_048_576,
    'gemini3flash': 1_048_576,
    'gemini25pro': 1_048_576,
    'gemini25flash': 1_048_576,
    // Moonshot
    'kimik25': 262_144,
    'kimik2': 262_144,
    // Z.ai
    'glm51': 200_000,
    'glm5': 200_000,
    'glm47': 202_752,
    'glm46': 200_000,
    'glm45': 131_072,
    // Alibaba Qwen
    'qwen35': 262_144,
    'qwen3coder': 262_144,
};

/**
 * Normalizes a model name for fuzzy matching.
 * Strips provider prefixes, lowercases, and removes separators.
 */
function normalize(name: string): string {
    return name
        .toLowerCase()
        .replace(/^(openai|anthropic|google|gemini|vertex_ai|bedrock|azure|together_ai|openrouter|novita|fireworks_ai|deepseek|mistral|moonshot|hf|huggingface)\//, '')
        .replace(/[-_.\s/:]/g, '');
}

/**
 * Pre-computed normalized index for fast lookup.
 * Built once on module load.
 */
const NORMALIZED_INDEX = new Map<string, number>();
for (const [name, info] of Object.entries(MODELS)) {
    NORMALIZED_INDEX.set(normalize(name), info.max_input_tokens);
}

/**
 * Resolves the max input tokens (context window) for a given model.
 *
 * Resolution order:
 *   1. Exact match in the LiteLLM model database
 *   2. Normalized match (strips provider prefix, punctuation, case)
 *   3. Partial/substring match on normalized names
 *   4. Default (128k)
 *
 * @param modelName - The model identifier (as configured in BYOK).
 * @returns Max input tokens for the model.
 */
export function getModelContextWindow(modelName?: string): number {
    if (!modelName || typeof modelName !== 'string') {
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }

    const normalized = normalize(modelName);

    // 1. Manual override (highest priority)
    if (MANUAL_OVERRIDES[normalized]) {
        return MANUAL_OVERRIDES[normalized];
    }
    // Manual override via substring match on normalized name
    for (const [overrideKey, tokens] of Object.entries(MANUAL_OVERRIDES)) {
        if (normalized.includes(overrideKey)) {
            return tokens;
        }
    }

    // 2. Exact match in LiteLLM
    const direct = MODELS[modelName];
    if (direct?.max_input_tokens) {
        return direct.max_input_tokens;
    }

    // 3. Normalized match in LiteLLM
    const normalizedHit = NORMALIZED_INDEX.get(normalized);
    if (normalizedHit) {
        return normalizedHit;
    }

    // 4. Substring match on LiteLLM — find the longest normalized key that matches
    let bestMatch = 0;
    let bestKeyLength = 0;
    for (const [key, tokens] of NORMALIZED_INDEX.entries()) {
        if (
            key.length > bestKeyLength &&
            (normalized.includes(key) || key.includes(normalized))
        ) {
            bestMatch = tokens;
            bestKeyLength = key.length;
        }
    }
    if (bestMatch > 0) {
        return bestMatch;
    }

    // 5. Default
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/**
 * Resolves the effective context window with the full fallback chain:
 *   1. User's explicit `maxInputTokens` in BYOK config (highest priority)
 *   2. LiteLLM lookup by model name
 *   3. Default 128k
 */
export function resolveContextWindow(params: {
    byokMaxInputTokens?: number;
    modelName?: string;
}): number {
    if (
        typeof params.byokMaxInputTokens === 'number' &&
        params.byokMaxInputTokens > 0
    ) {
        return params.byokMaxInputTokens;
    }

    return getModelContextWindow(params.modelName);
}
