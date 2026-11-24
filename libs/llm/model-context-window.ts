import modelData from './model-context-windows.json';

type MirrorRow = {
    max_input_tokens: number;
    litellm_provider?: string;
    source?: 'models.dev';
};

const ALL_ROWS = modelData as Record<string, MirrorRow>;

/** Rows from LiteLLM, current or kept from an earlier refresh. */
const MODELS: Record<string, MirrorRow> = {};
/** Rows filled from models.dev, read as `limit.context - limit.output` when
 *  the host publishes no input limit. That is a floor, often well below the
 *  real window, so they answer only a model every other step missed, and never
 *  a substring match (see `scripts/refresh-model-context-windows.mjs`). */
const MODELS_DEV: Record<string, MirrorRow> = {};
for (const [name, row] of Object.entries(ALL_ROWS)) {
    (row.source === 'models.dev' ? MODELS_DEV : MODELS)[name] = row;
}

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
    gptoss: 131_072,
    // Google — the 2.0 Flash pair lost its windowed row upstream on 2026-09-23.
    // LiteLLM kept `vertex_ai/gemini-2.0-flash` but without `max_input_tokens`,
    // and the refresh drops any row that cannot answer the question, so both
    // names fell out of the mirror while the models stayed in production.
    //
    // Without these two keys the fallback below resolves `gemini-2.0-flash` to
    // `gemini-2.0-flash-exp-image-generation` — the longest normalized key that
    // contains it — and answers 32,768 for a model that holds 1,048,576. That is
    // a thirty-twofold under-chunk, and it is the same longest-match trap the
    // comment above describes for this table, still live at step 4 against the
    // mirror. `-001` has no candidate at all and lands on the 128k default.
    //
    // 1,048,576 is Google's documented input limit and the value the mirror
    // itself carried until upstream dropped the row. Delete both the day
    // upstream publishes a window again.
    gemini20flash: 1_048_576,
    gemini20flash001: 1_048_576,
    // Google — the 3.x line is not in the mirror yet.
    gemini31pro: 1_048_576,
    gemini3pro: 1_048_576,
    gemini3flash: 1_048_576,
    // Moonshot
    kimik27: 262_144,
    kimik2: 262_144,
    // Z.ai
    glm51: 200_000,
    glm5: 200_000,
    glm47: 202_752,
    glm46: 200_000,
    glm45: 131_072,
    // Alibaba Qwen
    qwen35: 262_144,
    qwen3coder: 262_144,
    // Short ids that step 4 sends to an unrelated, smaller row:
    // `glm-4.7-flash` lands on a Cloudflare row (131,072, against Z.ai's
    // 200,000), `meta/llama-3.3-70b-instruct` on a Cloudflare fp8 row (24,000).
    glm47flash: 200_000,
    metallama3370binstruct: 128_000,
};

// These select models we cannot know. Preserve the planning default without
// presenting it as a known model limit, or matching an unrelated mirror row.
const ROUTING_ALIASES = new Set(['auto', 'coder']);

/**
 * Normalizes a model name for fuzzy matching.
 * Strips provider prefixes, lowercases, and removes separators.
 */
function normalize(name: string): string {
    return name
        .toLowerCase()
        .replace(
            /^(openai|anthropic|google|gemini|vertex_ai|bedrock|azure|together_ai|openrouter|novita|fireworks_ai|deepseek|mistral|moonshot|hf|huggingface)\//,
            '',
        )
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
const MODELS_DEV_INDEX = new Map<string, number>();
for (const [name, info] of Object.entries(MODELS_DEV)) {
    MODELS_DEV_INDEX.set(normalize(name), info.max_input_tokens);
}

/**
 * Resolves the max input tokens (context window) for a given model.
 *
 * Resolution order, most precise first:
 *   1. Exact match in the mirror
 *   2. Normalized match (strips provider prefix, punctuation, case)
 *   3. Routing alias default or manual override, exact on the normalized name
 *      — only reachable for a model the mirror does not have
 *   4. Partial/substring match on normalized names, LiteLLM rows only
 *   5. models.dev row, exact or normalized
 *   6. Default (128k)
 *
 * The overrides used to sit at position 1 AND match by substring, so a
 * hand-typed number for an older model silently overruled real data for a newer
 * one that merely shared its prefix. Precision now decides precedence.
 *
 * @param modelName - The model identifier (as configured in BYOK).
 * @returns Max input tokens for the model.
 */
export function getModelContextWindow(modelName?: string): number {
    return lookupModelContextWindow(modelName) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/**
 * The same resolution, WITHOUT the default — `undefined` means "this model is
 * unknown to us", which is a different answer from "this model holds 128k".
 *
 * Both callers need the distinction and they resolve it differently: the BYOK
 * review path substitutes its own conservative 128k, while the managed chunker
 * substitutes the budget ITS caller passed in. Collapsing the two answers into
 * one number is what let a second source grow — the managed path could not use
 * this function, so it grew its own table in the provider registry, and the two
 * drifted apart.
 */
export function lookupModelContextWindow(
    modelName?: string,
): number | undefined {
    return lookupContextWindowWithSource(modelName)?.tokens;
}

/** Where a context window came from. Partial matches, models.dev floors and
 *  routing defaults are estimates, not known input limits for rejection. */
export type ContextWindowSource =
    | 'byok'
    | 'litellm'
    | 'litellm-partial'
    | 'override'
    | 'models.dev'
    | 'default';

export type ResolvedContextWindow = {
    tokens: number;
    source: ContextWindowSource;
};

function lookupContextWindowWithSource(
    modelName?: string,
): ResolvedContextWindow | undefined {
    if (!modelName || typeof modelName !== 'string') {
        return undefined;
    }

    const normalized = normalize(modelName);

    // 1. Exact match in the mirror — the model id as the vendor writes it.
    const direct = MODELS[modelName];
    if (direct?.max_input_tokens) {
        return { tokens: direct.max_input_tokens, source: 'litellm' };
    }

    // 2. Normalized match in the mirror.
    const normalizedHit = NORMALIZED_INDEX.get(normalized);
    if (normalizedHit) {
        return { tokens: normalizedHit, source: 'litellm' };
    }

    // 3. Gateway aliases keep a planning budget, not a known input limit.
    if (ROUTING_ALIASES.has(normalized)) {
        return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' };
    }

    // Manual override — a model upstream does not carry yet. Exact only: a
    //    substring match here is what pinned claude-opus-4-7 to its 4.x sibling.
    if (MANUAL_OVERRIDES[normalized]) {
        return { tokens: MANUAL_OVERRIDES[normalized], source: 'override' };
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
        return { tokens: bestMatch, source: 'litellm-partial' };
    }

    // 5. models.dev — a floor for a model nobody else knows.
    const modelsDevHit =
        MODELS_DEV[modelName]?.max_input_tokens ??
        MODELS_DEV_INDEX.get(normalized);
    if (modelsDevHit) {
        return { tokens: modelsDevHit, source: 'models.dev' };
    }

    // 6. Unknown — the caller decides what to substitute.
    return undefined;
}

/**
 * Resolves the effective context window with the full fallback chain:
 *   1. User's explicit `maxInputTokens` in BYOK config (highest priority)
 *   2. Mirror lookup by model name
 *   3. Default 128k
 */
export function resolveContextWindow(params: {
    byokMaxInputTokens?: number;
    modelName?: string;
}): number {
    return resolveContextWindowWithSource(params).tokens;
}

/** `resolveContextWindow`, plus which step answered. */
export function resolveContextWindowWithSource(params: {
    byokMaxInputTokens?: number;
    modelName?: string;
}): ResolvedContextWindow {
    if (
        typeof params.byokMaxInputTokens === 'number' &&
        params.byokMaxInputTokens > 0
    ) {
        return { tokens: params.byokMaxInputTokens, source: 'byok' };
    }

    return (
        lookupContextWindowWithSource(params.modelName) ?? {
            tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
            source: 'default',
        }
    );
}
