/**
 * Per-provider capability helpers for `supportsStructuredOutputs: true` on
 * `@ai-sdk/openai-compatible` builds. Each provider module calls the helper for
 * ITS OWN policy — there is no provider switch here: the module already knows
 * which one applies (openrouter → prefix rule, openai_compatible → baseURL
 * heuristic). novita/moonshot don't enable via a heuristic at all (novita varies
 * too wildly; moonshot uses the never-downgrade override below).
 *
 * A dependency-free leaf (plain strings, no LangChain, no registry) so the
 * provider modules can import it without a cycle.
 */

/** OpenRouter model prefixes known to honor strict `response_format: json_schema`. */
export const OPENROUTER_JSON_SCHEMA_PREFIXES = [
    'openai/',
    'anthropic/',
    'google/',
    'moonshotai/',
];

/**
 * OpenRouter: enable strict json_schema only for upstreams we have evidence
 * honor it (the prefixes above). Anything else falls back to `json_object`.
 */
export function openRouterHonorsJsonSchema(model: string): boolean {
    return OPENROUTER_JSON_SCHEMA_PREFIXES.some((p) =>
        model.toLowerCase().startsWith(p),
    );
}

/**
 * openai_compatible (custom endpoint): conservative baseURL heuristic — enable
 * only when we have strong evidence the upstream honors strict json_schema.
 * Anything else returns false so the SDK falls back to `json_object`.
 *
 * Self-hosted env mode (`API_LLM_PROVIDER_MODEL`) is handled by its own branch in
 * `resolveManagedSlot` — an explicit customer-controlled deployment, so the
 * caller's opt-in is trusted there.
 */
export function openAiCompatibleHonorsJsonSchema(baseURL?: string): boolean {
    if (!baseURL) return false;
    // vLLM defaults to port 8000 and the issue's target case.
    if (/:8000(\/|$)/.test(baseURL)) return true;
    // Fireworks supports strict json_schema via structuredOutputs. Without this
    // flag the AI SDK emits legacy response_format and the provider warns (and
    // may ignore the schema).
    if (/api\.fireworks\.ai/i.test(baseURL)) return true;
    // Opt-in comma-separated allowlist of substrings, e.g.
    // "vllm.internal,my-llm-proxy.example.com". Set by ops when running behind a
    // non-vLLM but schema-capable proxy.
    const allowList = process.env.API_TRUST_JSON_SCHEMA_BASE_URLS;
    if (allowList) {
        const needles = allowList
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (needles.some((needle) => baseURL.includes(needle))) return true;
    }
    return false;
}

/**
 * Kimi / Moonshot (incl. `moonshotai/…`) must NEVER be downgraded to
 * `json_object`: measured to lose ~50% of structured outputs when forced off
 * native `json_schema` (Phase 0 D-00b, Pitfall 2). Provider modules honor this
 * in `build()` as an ADDITIVE override — so a direct-Moonshot upstream
 * (api.moonshot.ai) keeps json_schema ON even though the baseURL heuristic alone
 * would reject it. Lives here (the shared leaf) so the openai module (kimi served
 * over `openai_compatible`) and the moonshot module share ONE policy — no fork.
 */
export function isNeverDowngradeModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.includes('kimi') || m.includes('moonshot');
}
