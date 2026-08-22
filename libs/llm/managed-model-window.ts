/**
 * The input-token ceiling for a MANAGED-catalog model id, sourced from the
 * provider registry's `capabilities().maxInputTokens` — the single home for
 * per-model context windows. Replaces the old standalone MODEL_INPUT_MAX_TOKENS
 * table so the window for a model lives in exactly one place (the provider
 * module), the same source every other capability reads.
 *
 * Input is an `LLMModelProvider` enum value (`"<vendor>:<model>"`, e.g.
 * `"google:gemini-2.5-pro"`). Returns `undefined` for a bare BYOK model string
 * (no vendor prefix) or an unknown id — the caller then falls back to its
 * default budget. BYOK slots carry their own `maxInputTokens` and never route
 * through here (they pass `overrideMaxTokens`).
 */
import { REGISTRY } from '@libs/llm/providers';

// The managed enum's vendor prefixes → registry provider ids. The enum is a
// closed set, so this map is exhaustive for it (openai/anthropic/google/vertex/
// novita). google → the Gemini module; vertex → the Vertex module.
const VENDOR_TO_PROVIDER_ID: Record<string, string> = {
    openai: 'openai',
    anthropic: 'anthropic',
    google: 'google_gemini',
    vertex: 'google_vertex',
    novita: 'novita',
};

export function managedModelMaxInputTokens(id?: string): number | undefined {
    if (!id) return undefined;
    const sep = id.indexOf(':');
    if (sep < 0) return undefined; // bare BYOK model string — not a managed id
    const providerId = VENDOR_TO_PROVIDER_ID[id.slice(0, sep)];
    if (!providerId || !REGISTRY.has(providerId)) return undefined;
    return REGISTRY.get(providerId).capabilities(id.slice(sep + 1))
        .maxInputTokens;
}
