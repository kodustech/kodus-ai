/**
 * Provider cache hint for the SYSTEM prompt — domain-agnostic.
 *
 * Anthropic supports `cacheControl: ephemeral` on a message: a long system
 * prompt (workflow + rules + context) is then cached and read from cache on the
 * many subsequent steps of an agent loop — a large cost/latency win on cache
 * hits. This returns the providerOptions to attach to the system message when
 * the model is Claude/Anthropic-based, or `undefined` for other providers (the
 * caller then sends a plain system string).
 *
 * Detection mirrors the legacy path: match `claude`/`anthropic` in the model id.
 * Emitting the `anthropic` namespace for a non-native provider (e.g. Claude via
 * OpenRouter) is a harmless no-op — that provider ignores the unknown namespace.
 */
export function anthropicSystemCacheControl(
    model: unknown,
): Record<string, unknown> | undefined {
    const modelId: string = (model as any)?.modelId ?? '';
    if (/claude|anthropic/i.test(modelId)) {
        return { anthropic: { cacheControl: { type: 'ephemeral' } } };
    }
    return undefined;
}
