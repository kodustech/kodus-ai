/**
 * The Anthropic inline prompt-cache marker.
 *
 * `{ anthropic: { cacheControl: ephemeral } }` is the `providerOptions` shape the
 * Anthropic API honors — and, per the AI SDK docs, the SAME shape the
 * Anthropic-on-Bedrock and Anthropic-on-Vertex adapters honor for Claude models.
 * Keeping ONE constructor means the three Claude paths (native / Bedrock / Vertex)
 * never drift on the marker shape; each module's `systemCacheControl` returns THIS.
 */
export const anthropicEphemeralCacheHint = (): Record<string, unknown> => ({
    anthropic: { cacheControl: { type: 'ephemeral' } },
});

/**
 * True for a Claude model id in any of its provider spellings: native
 * `claude-3-5-sonnet…`, Bedrock `us.anthropic.claude-…-v1:0`, Vertex
 * `claude-…@20240620`. Used by the Bedrock/Vertex modules to emit the cache hint
 * ONLY for the Anthropic-family deployments they host (Gemini/Nova/Llama on the
 * same provider cache implicitly, so they must NOT get an inline marker).
 */
export const isAnthropicModel = (model: string): boolean =>
    /claude|anthropic/i.test(model);
