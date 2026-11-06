import { resolveSlotCallOptions } from './slot-call-options';

describe('resolveSlotCallOptions — the single slot→call-tuning mapping', () => {
    it('passes through a configured temperature + maxOutputTokens', () => {
        expect(
            resolveSlotCallOptions({
                provider: 'openai',
                temperature: 0.3,
                maxOutputTokens: 5000,
            } as any),
        ).toEqual({ temperature: 0.3, maxOutputTokens: 5000 });
    });

    it('omits unset knobs so the model default applies', () => {
        expect(resolveSlotCallOptions({ provider: 'openai' } as any)).toEqual(
            {},
        );
        expect(resolveSlotCallOptions(null)).toEqual({});
        expect(resolveSlotCallOptions(undefined)).toEqual({});
    });

    it('keeps temperature 0 (deterministic) but drops non-positive maxOutputTokens', () => {
        expect(
            resolveSlotCallOptions({
                provider: 'openai',
                temperature: 0,
                maxOutputTokens: 0,
            } as any),
        ).toEqual({ temperature: 0 });
    });

    // @ai-sdk/anthropic returns maxOutputTokens:4096 for unknown model ids.
    // anthropic_compatible slots whose model is not a Claude id (Kimi, GLM,
    // DeepSeek, MiniMax, …) must receive an explicit default so the model can
    // use its own ceiling rather than the SDK's 4096 floor.
    it('injects a large default maxOutputTokens for anthropic_compatible non-Claude ids', () => {
        for (const model of [
            'kimi-k2.7-code',
            'kimi-k2.6',
            'glm-5.3',
            'deepseek-v3',
            'minimax-m3',
        ]) {
            const result = resolveSlotCallOptions({
                provider: 'anthropic_compatible',
                model,
            } as any);
            expect(result.maxOutputTokens).toBeGreaterThan(4096);
        }
    });

    it('does NOT inject a default for anthropic_compatible Claude ids', () => {
        // A real Claude id proxied over a compatible endpoint is still known to
        // @ai-sdk/anthropic — the SDK sets the right ceiling itself.
        for (const model of [
            'claude-sonnet-4-5',
            'claude-opus-4-8',
            'claude_3_haiku',
        ]) {
            const result = resolveSlotCallOptions({
                provider: 'anthropic_compatible',
                model,
            } as any);
            expect(result.maxOutputTokens).toBeUndefined();
        }
    });

    it('honours an explicit maxOutputTokens over the default on anthropic_compatible', () => {
        expect(
            resolveSlotCallOptions({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.7-code',
                maxOutputTokens: 8000,
            } as any),
        ).toMatchObject({ maxOutputTokens: 8000 });
    });
});
