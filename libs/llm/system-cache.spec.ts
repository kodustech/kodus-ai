import { systemCacheControl } from './system-cache';

// Uses the REAL registry (provider modules self-register via the barrel import
// inside system-cache.ts) so the test exercises the actual per-provider wiring —
// the point of the refactor is that behavior is registry-driven, not a regex.
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

describe('systemCacheControl — registry-driven, protocol-aware', () => {
    it('emits the anthropic ephemeral hint for the anthropic provider', () => {
        expect(
            systemCacheControl({ provider: 'anthropic', model: 'claude-sonnet-4' }),
        ).toEqual(EPHEMERAL);
    });

    it('emits it for anthropic_compatible (alias → same module, same protocol)', () => {
        expect(
            systemCacheControl({
                provider: 'anthropic_compatible',
                model: 'kimi-k2-code',
            }),
        ).toEqual(EPHEMERAL);
    });

    it('does NOT emit for a Claude served via OpenRouter (the cross-provider bug the regex had)', () => {
        // openrouter speaks the openai protocol → no anthropic inline hint, even
        // though the model name contains "claude". The old regex got this wrong.
        expect(
            systemCacheControl({
                provider: 'open_router',
                model: 'anthropic/claude-3.5-sonnet',
            }),
        ).toBeUndefined();
    });

    it('does NOT emit for providers that cache implicitly (openai)', () => {
        expect(
            systemCacheControl({ provider: 'openai', model: 'gpt-4o' }),
        ).toBeUndefined();
    });

    it('falls back to name detection when no provider (managed/env default)', () => {
        expect(systemCacheControl({ model: 'claude-sonnet-4' })).toEqual(
            EPHEMERAL,
        );
        expect(systemCacheControl({ model: 'gpt-4o' })).toBeUndefined();
    });

    it('accepts a built model object (`.modelId`) for the fallback path', () => {
        expect(
            systemCacheControl({ model: { modelId: 'claude-3-opus' } }),
        ).toEqual(EPHEMERAL);
    });

    it('is undefined for an unknown provider with a non-Claude model', () => {
        expect(
            systemCacheControl({ provider: 'totally-unknown', model: 'foo' }),
        ).toBeUndefined();
    });

    // Claude hosted on Bedrock / Vertex accepts the SAME anthropic inline marker
    // (per the AI SDK docs), but ONLY for the Anthropic-family deployments — the
    // Gemini/Nova/Llama models on those same providers cache implicitly.
    it('emits the hint for Claude-on-Bedrock, not for a non-Claude Bedrock model', () => {
        expect(
            systemCacheControl({
                provider: 'amazon_bedrock',
                model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
            }),
        ).toEqual(EPHEMERAL);
        expect(
            systemCacheControl({
                provider: 'amazon_bedrock',
                model: 'amazon.nova-pro-v1:0',
            }),
        ).toBeUndefined();
    });

    it('emits the hint for Claude-on-Vertex, not for Gemini-on-Vertex', () => {
        expect(
            systemCacheControl({
                provider: 'google_vertex',
                model: 'claude-3-5-sonnet-v2@20241022',
            }),
        ).toEqual(EPHEMERAL);
        expect(
            systemCacheControl({
                provider: 'google_vertex',
                model: 'gemini-2.5-pro',
            }),
        ).toBeUndefined();
    });
});
