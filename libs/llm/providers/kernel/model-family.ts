/**
 * The ONE list of model families, and the ONE function that names a model's.
 *
 * WHY IT EXISTS
 * "Does this model reason, and how" was answered by two dispatchers that each
 * knew half the families, and neither knew the other's:
 *
 *   model-reasoning.ts    claude / gemini / openai   → ReasoningConfig (UI shape)
 *   reasoning-traits.ts   glm / kimi / deepseek      → ModelReasoningTraits (behavior)
 *
 * Every model was known to exactly ONE of them, so each answered "no" for the
 * other's families — silently, because "no reasoning" is a valid answer:
 *
 *   kimi-k2.6              config: NONE     traits: thinks
 *   z-ai/glm-5.3           config: NONE     traits: thinks
 *   deepseek-v4-pro        config: NONE     traits: thinks
 *   claude-opus-5          config: adaptive traits: (falls to unknown default)
 *
 * That is not academic. `moonshotai.kimi-k2.5` and `minimax.minimax-m2` are live
 * Bedrock slots, and Bedrock asks the config dispatcher — so both were reported
 * to the UI as `supportsReasoning: false`. A model the customer chose FOR its
 * reasoning could not be given an effort at all.
 *
 * So the family list lives here, once. Both dispatchers read it, and a family
 * that is added is added for both.
 */

export type ModelFamily =
    | 'anthropic'
    | 'gemini'
    | 'openai'
    | 'glm'
    | 'kimi'
    | 'deepseek'
    | 'minimax'
    | 'unknown';

/**
 * Name the family from the model id. Order matters only where an id could match
 * two patterns; today none do, and the vendor-prefixed forms every aggregator
 * uses (`z-ai/glm-5.2`, `moonshotai.kimi-k2.5`, `anthropic.claude-opus-4-7`)
 * still match on the model name itself.
 *
 * KNOWN LIMIT, stated rather than hidden: this reads a string the customer typed
 * into a free-text field. A proxy that renames the model (`prod-model-1` serving
 * a Kimi) is `unknown` here, and every consumer must stay safe under `unknown` —
 * which is why the unknown defaults never FORCE a parameter, only withhold one.
 */
export function detectModelFamily(model?: string): ModelFamily {
    const m = (model ?? '').toLowerCase();
    if (!m) {
        return 'unknown';
    }

    if (m.includes('claude')) {
        return 'anthropic';
    }
    if (m.includes('gemini')) {
        return 'gemini';
    }
    // `glm` is a brand token; bounded so an unrelated id carrying the digits
    // "5.3" somewhere cannot be mistaken for GLM-5.3 further down.
    if (m.includes('glm')) {
        return 'glm';
    }
    // `^k<digit>` catches the BARE Moonshot ids (`k3`, `k3-256k`, `k2.6`) that
    // api.kimi.com serves alongside the prefixed ones.
    if (m.includes('kimi') || m.includes('moonshot') || /^k[0-9]/.test(m)) {
        return 'kimi';
    }
    if (m.includes('deepseek')) {
        return 'deepseek';
    }
    if (m.includes('minimax')) {
        return 'minimax';
    }
    if (isOpenAiReasonerId(m) || /^(gpt|chatgpt|o[0-9])/.test(m)) {
        return 'openai';
    }
    return 'unknown';
}

/**
 * o-series / gpt-5 / deep-research — OpenAI's reasoning ids. THE predicate; the
 * openai and azure modules both call this one.
 *
 * The comment here used to claim the openai module "re-exports its own predicate
 * over the same rule". It did not — there were three near-copies that disagreed:
 * azure matched `gpt-5` unanchored and knew nothing of deep-research, openai
 * anchored it and also missed deep-research. Same question, three answers,
 * which is how this layer keeps producing the same defect.
 */
export function isOpenAiReasonerId(model?: string): boolean {
    // Callers legitimately pass an unset model (a slot with no id yet). The
    // regexes the three copies used coerced `undefined` to the string
    // "undefined" and answered false by accident; this says so on purpose.
    if (!model) return false;
    const m = model.toLowerCase();
    return (
        /^o[134](\b|[-_@])/.test(m) ||
        /^gpt-5(\b|[-_@])/.test(m) ||
        /deep-research/.test(m)
    );
}

/** True for the families spoken over an OpenAI-/Anthropic-COMPATIBLE endpoint,
 *  whose facts live in the shared table rather than in a provider folder. */
export function isCompatibleFamily(family: ModelFamily): boolean {
    return (
        family === 'glm' ||
        family === 'kimi' ||
        family === 'deepseek' ||
        family === 'minimax'
    );
}
