import modelData from './model-context-windows.json';

const MODELS = modelData as Record<
    string,
    { max_input_tokens: number; litellm_provider?: string }
>;

/** Conservative default when the model is unknown. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Windows for models the mirror does NOT have. Consulted only after an exact and
 * a normalized lookup have both missed (see `getModelContextWindow`), so an
 * entry here can never contradict real upstream data.
 *
 * It used to run FIRST, and by SUBSTRING, which made it the most dangerous table
 * in the file. `claudeopus4` swallowed claude-opus-4-7 and -4-8 — the substring
 * matches — and pinned two models that hold 1,000,000 tokens to 200,000. `gpt5`
 * did the same to gpt-5.5 and the gpt-5.6 line, and `deepseekv4flash` to a model
 * upstream rates at 1,048,576. Every one of those is a live production slot, and
 * an eightfold under-chunk is invisible: it costs calls and context, never an
 * error. Matching is now EXACT on the normalized name.
 *
 * Add a key only when upstream genuinely lacks the model, and drop it once
 * upstream has it — `scripts/refresh-model-context-windows.mjs` is what keeps
 * upstream current, so a hand-typed number is a stopgap, never the source.
 */
const MANUAL_OVERRIDES: Record<string, number> = {
    // OpenAI
    'gptoss': 131_072,
    // Google — the 3.x line is not in the mirror yet.
    'gemini31pro': 1_048_576,
    'gemini3pro': 1_048_576,
    'gemini3flash': 1_048_576,
    // Moonshot
    'kimik27': 262_144,
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
 * Resolution order, most precise first:
 *   1. Exact match in the mirror
 *   2. Normalized match (strips provider prefix, punctuation, case)
 *   3. Manual override, exact on the normalized name — only reachable for a
 *      model the mirror does not have
 *   4. Partial/substring match on normalized names
 *   5. Default (128k)
 *
 * The overrides used to sit at position 1 AND match by substring, so a
 * hand-typed number for an older model silently overruled real data for a newer
 * one that merely shared its prefix. Precision now decides precedence.
 *
 * @param modelName - The model identifier (as configured in BYOK).
 * @returns Max input tokens for the model.
 */
export function getModelContextWindow(modelName?: string): number {
    if (!modelName || typeof modelName !== 'string') {
        return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }

    const normalized = normalize(modelName);

    // 1. Exact match in the mirror — the model id as the vendor writes it.
    const direct = MODELS[modelName];
    if (direct?.max_input_tokens) {
        return direct.max_input_tokens;
    }

    // 2. Normalized match in the mirror.
    const normalizedHit = NORMALIZED_INDEX.get(normalized);
    if (normalizedHit) {
        return normalizedHit;
    }

    // 3. Manual override — a model upstream does not carry yet. Exact only: a
    //    substring match here is what pinned claude-opus-4-7 to its 4.x sibling.
    if (MANUAL_OVERRIDES[normalized]) {
        return MANUAL_OVERRIDES[normalized];
    }

    // 4. Substring match on the mirror — find the longest normalized key that matches
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
