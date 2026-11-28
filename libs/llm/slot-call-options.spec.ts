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

    // @ai-sdk/anthropic caps output at 4096 for any model id it does not recognise.
    // For Anthropic-wire providers with non-Claude ids (Kimi, GLM, DeepSeek, ...),
    // we inject a large FALLBACK via defaultMaxOutputTokens. It ranks below both the
    // slot's own maxOutputTokens and any per-agent caller cap, so agents can still
    // set a smaller ceiling without fighting the slot.
    it('injects a large defaultMaxOutputTokens (not maxOutputTokens) for anthropic_compatible non-Claude ids', () => {
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
            expect(result.defaultMaxOutputTokens).toBeGreaterThan(4096);
            expect(result.maxOutputTokens).toBeUndefined();
        }
    });

    it('does NOT inject a default for anthropic_compatible hyphenated Claude ids', () => {
        // @ai-sdk/anthropic only recognises hyphenated 'claude-' ids -- the SDK
        // sets the right ceiling for those itself.
        for (const model of [
            'claude-sonnet-4-5',
            'claude-opus-4-8',
            'claude-3-haiku-20240307',
        ]) {
            const result = resolveSlotCallOptions({
                provider: 'anthropic_compatible',
                model,
            } as any);
            expect(result.maxOutputTokens).toBeUndefined();
            expect(result.defaultMaxOutputTokens).toBeUndefined();
        }
    });

    it('injects a default for underscore-prefixed Claude ids (not recognised by the SDK)', () => {
        // @ai-sdk/anthropic only recognises 'claude-' (hyphen), not 'claude_'
        // (underscore). An underscore id is unknown to the SDK and floors at 4096.
        const result = resolveSlotCallOptions({
            provider: 'anthropic_compatible',
            model: 'claude_3_haiku',
        } as any);
        expect(result.defaultMaxOutputTokens).toBeGreaterThan(4096);
    });

    it('injects a default for brand slots (moonshot/zai) with non-Claude model ids', () => {
        // Brand slots keep their own provider id ('moonshot'/'zai') on the slot --
        // they only present as 'anthropic_compatible' at build time, so the guard
        // must include the brand ids.
        for (const [provider, model] of [
            ['moonshot', 'kimi-k2.7-code'],
            ['moonshot', 'kimi-k2.6'],
            ['zai', 'glm-5.3'],
            ['zai', 'glm-4-flash'],
        ]) {
            const result = resolveSlotCallOptions({ provider, model } as any);
            expect(result.defaultMaxOutputTokens).toBeGreaterThan(4096);
        }
    });

    it('injects a default when given an env descriptor shape (provider + model, no BYOK slot)', () => {
        // The env/managed path passes an envDescriptor -- just provider + model,
        // no temperature or maxOutputTokens fields -- to resolveSlotCallOptions.
        // The default must fire for Anthropic-wire env providers too.
        const result = resolveSlotCallOptions({
            provider: 'anthropic_compatible',
            model: 'kimi-k2.7-code',
        } as any);
        expect(result.defaultMaxOutputTokens).toBeGreaterThan(4096);
    });

    it('honours an explicit maxOutputTokens over the default on anthropic_compatible', () => {
        const result = resolveSlotCallOptions({
            provider: 'anthropic_compatible',
            model: 'kimi-k2.7-code',
            maxOutputTokens: 8000,
        } as any);
        expect(result.maxOutputTokens).toBe(8000);
        expect(result.defaultMaxOutputTokens).toBeUndefined();
    });
});
