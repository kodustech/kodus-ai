import { resolveByokTemperature } from './sampling-params';

/**
 * Characterization: temperature resolution routes through the provider module
 * contract (`temperaturePolicy`) instead of an inline anthropic import. These lock
 * the three policy outcomes — unsupported (withheld), fixed (pinned over the stored
 * value), adjustable (stored value stands) — including the anthropic_compatible
 * (Kimi) cases a naive model-name-only check would regress.
 */
describe('resolveByokTemperature (via provider registry)', () => {
    it('withholds temperature from real Anthropic 4.7+ (400 otherwise)', () => {
        expect(
            resolveByokTemperature({
                provider: 'anthropic',
                model: 'claude-opus-4-8',
                temperature: 0.7,
            }),
        ).toBeUndefined();
        expect(
            resolveByokTemperature({
                provider: 'anthropic',
                model: 'claude-opus-5',
                temperature: 0.2,
            }),
        ).toBeUndefined();
    });

    it('keeps temperature for Anthropic models that still accept it', () => {
        expect(
            resolveByokTemperature({
                provider: 'anthropic',
                model: 'claude-sonnet-4-5',
                temperature: 0.3,
            }),
        ).toBe(0.3);
    });

    // Both Kimi cases below used to assert a temperature going OUT. The vendor
    // says none should: platform.kimi.ai documents k2.7-code as "temperature is
    // not modifiable and thinking is always on; neither needs to be set" and
    // k2.6 as "temperature is not modifiable, so no need to set it". Omitting is
    // the only reading of that; a pinned 1 and a passed-through 0.3 are both a
    // value the model does not read.
    it('OMITS temperature for k2.7-code — unmodifiable, so not even the pin', () => {
        // Still covers the original "Temp: 0 saved on a Kimi model" incident: a
        // stale stored 0 must not reach the wire. It now resolves to nothing
        // rather than to 1, which is the stronger and better-sourced answer.
        for (const stored of [0, 0.7, undefined, 1]) {
            expect(
                resolveByokTemperature({
                    provider: 'anthropic_compatible',
                    model: 'kimi-k2.7-code',
                    temperature: stored,
                }),
            ).toBeUndefined();
        }
        // Same over the brand id (moonshot), not just the raw transport id.
        expect(
            resolveByokTemperature({
                provider: 'moonshot',
                model: 'kimi-k2.7-code',
                temperature: 0,
            }),
        ).toBeUndefined();
    });

    it('OMITS temperature for k2.6 too — the two facts are independent', () => {
        // k2.6 CAN turn thinking off, which is why it read as an ordinary
        // adjustable model and shipped the stored 0.3. Its temperature is fixed
        // by the vendor in every mode, so thinking control says nothing about it.
        expect(
            resolveByokTemperature({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.6',
                temperature: 0.3,
            }),
        ).toBeUndefined();
    });

    it('keeps the stored temperature for k2.5 — no source says otherwise', () => {
        // The scope line: platform.kimi.ai covers k2.6 and k2.7-code and does not
        // cover k2.5. Omitting would be the safer guess and is still a guess.
        expect(
            resolveByokTemperature({
                provider: 'anthropic_compatible',
                model: 'kimi-k2.5',
                temperature: 0.3,
            }),
        ).toBe(0.3);
    });

    // ── DeepSeek: the constraint is scoped to thinking being ON ─────────────
    // "Thinking mode does not support the temperature, top_p, presence_penalty,
    // or frequency_penalty parameters" (api-docs.deepseek.com). That is a rule
    // about the MODE, not the model — reading it as "this model never takes a
    // temperature" took away a setting that works when reasoning is off.
    it('withholds temperature from DeepSeek while it is thinking', () => {
        expect(
            resolveByokTemperature({
                provider: 'openai_compatible',
                model: 'deepseek-v4-pro',
                temperature: 0.2,
                reasoningEffort: 'high',
            }),
        ).toBeUndefined();
    });

    it('withholds it on an UNSET effort too — the family default is thinking ON', () => {
        // DeepSeek thinks by default, so "no effort configured" is not "off".
        expect(
            resolveByokTemperature({
                provider: 'openai_compatible',
                model: 'deepseek-v4-pro',
                temperature: 0.2,
            }),
        ).toBeUndefined();
    });

    it('KEEPS temperature on DeepSeek once reasoning is explicitly off', () => {
        expect(
            resolveByokTemperature({
                provider: 'openai_compatible',
                model: 'deepseek-v4-pro',
                temperature: 0.2,
                reasoningEffort: 'none',
            }),
        ).toBe(0.2);
    });

    it('still pins an ALWAYS-thinking model at 1 even when effort says none', () => {
        // k3 and GLM-5.3 expose no off switch, so picking "none" does not
        // actually stop them thinking — the pin is not effort-scoped.
        //
        // k2.7-code was dropped from this list, not because the rule changed but
        // because a STRONGER fact now covers it: the vendor documents its
        // temperature as unmodifiable, so it is omitted before the pin is even
        // consulted. k3 keeps the pin — platform.kimi.ai says nothing about its
        // temperature, so the older reasoning-based answer is the best available.
        for (const model of ['k3', 'glm-5.3']) {
            expect(
                resolveByokTemperature({
                    provider: 'anthropic_compatible',
                    model,
                    temperature: 0.3,
                    reasoningEffort: 'none',
                }),
            ).toBe(1);
        }
    });

    it('leaves GLM alone — Z.ai supports sampling params while thinking', () => {
        // The rule is per BRAND, not per transport: same endpoint family as
        // DeepSeek, opposite documented behaviour.
        expect(
            resolveByokTemperature({
                provider: 'openai_compatible',
                model: 'glm-5.2',
                temperature: 0.4,
                reasoningEffort: 'high',
            }),
        ).toBe(0.4);
    });

    it('applies the always-thinking pin on OpenRouter too — same model, any transport', () => {
        // OpenRouter hosts the model, it does not change what the model IS.
        // Before the module delegated the shared traits, the exact same glm-5.3
        // was pinned to 1 over openai_compatible and got a raw 0 here.
        expect(
            resolveByokTemperature({
                provider: 'open_router',
                model: 'z-ai/glm-5.3',
                temperature: 0,
            }),
        ).toBe(1);
    });

    it('keeps temperature for non-anthropic providers', () => {
        // gpt-4o, NOT gpt-5: this test's point is that a non-Anthropic provider
        // does not inherit Anthropic's withholding. It used to use gpt-5, which
        // is itself a reasoner that rejects temperature — so it was asserting a
        // bug (we sent 0.5 to a model that refuses it) under a name about
        // something else entirely.
        expect(
            resolveByokTemperature({
                provider: 'openai',
                model: 'gpt-4o',
                temperature: 0.5,
            }),
        ).toBe(0.5);
    });

    it('withholds temperature from a NATIVE OpenAI reasoner', () => {
        // gpt-5.x / o-series reject the param. The openai module returns no
        // policy for native OpenAI on purpose and leaves the answer to the
        // static `capabilities().supportsTemperature` flag — the runtime used to
        // skip that fallback while the connect form applied it, so the form hid
        // the field and the runtime sent the value anyway. 26 production slots
        // carry a temperature on these models.
        for (const model of ['gpt-5.4', 'o3']) {
            expect(
                resolveByokTemperature({
                    provider: 'openai',
                    model,
                    temperature: 0.2,
                }),
            ).toBeUndefined();
        }
    });

    it('returns undefined when nothing is configured, keeps 0', () => {
        expect(resolveByokTemperature(undefined)).toBeUndefined();
        expect(
            resolveByokTemperature({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
        ).toBeUndefined();
        // 0 is a real (deterministic) value, not "unset".
        expect(
            resolveByokTemperature({
                provider: 'openai',
                model: 'gpt-4o',
                temperature: 0,
            }),
        ).toBe(0);
    });

    it('defaults to keeping temperature for an unregistered provider', () => {
        expect(
            resolveByokTemperature({
                provider: 'some_unregistered_provider',
                model: 'whatever',
                temperature: 0.9,
            }),
        ).toBe(0.9);
    });
});
