/**
 * Capability gate for `supportsStructuredOutputs: true` on
 * `@ai-sdk/openai-compatible` providers (openai_compatible, open_router, novita).
 *
 * Extracted from byok-to-vercel.ts into a dependency-free leaf so BOTH the
 * legacy switch AND the new provider modules (libs/llm/providers/*) share ONE
 * gate — no fork, no circular import between a module and byok-to-vercel.
 *
 * Provider ids are plain strings here (matching `BYOKProvider` values) so this
 * leaf has no runtime dependency on kodus-common (REQ-NOLC-01).
 */

/** OpenRouter model prefixes known to honor strict `response_format: json_schema`. */
export const OPENROUTER_JSON_SCHEMA_PREFIXES = [
    'openai/',
    'anthropic/',
    'google/',
    'moonshotai/',
];

/**
 * Conservative gate: returns true only when we have strong evidence the upstream
 * honors strict `response_format: json_schema`. Anything else returns false so
 * the SDK falls back to `json_object` and the upstream sees the request shape it
 * always saw.
 *
 * Self-hosted env mode (`API_LLM_PROVIDER_MODEL`) is handled by its own branch in
 * `byokToVercelModel`/`getInternalModel` — an explicit customer-controlled
 * deployment, so the caller's opt-in is trusted there.
 */
export function shouldEnableJsonSchema(
    provider: string,
    model: string,
    baseURL?: string,
): boolean {
    if (provider === 'open_router') {
        return OPENROUTER_JSON_SCHEMA_PREFIXES.some((p) =>
            model.toLowerCase().startsWith(p),
        );
    }
    if (provider === 'openai_compatible') {
        if (!baseURL) return false;
        // vLLM defaults to port 8000 and the issue's target case.
        if (/:8000(\/|$)/.test(baseURL)) return true;
        // Opt-in comma-separated allowlist of substrings, e.g.
        // "vllm.internal,my-llm-proxy.example.com". Set by ops when running
        // behind a non-vLLM but schema-capable proxy.
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
    // NOVITA varies wildly by upstream — too risky to enable by default.
    // Unknown / fallback openai-compatible: same.
    return false;
}
