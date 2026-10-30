import '@libs/llm/providers'; // side-effect: self-register every provider module
import { GetModelCapabilitiesUseCase } from './get-model-capabilities.use-case';

const build = (supported = true) => {
    const providerService = {
        isProviderSupported: () => supported,
    } as any;
    return new GetModelCapabilitiesUseCase(providerService);
};

describe('GetModelCapabilitiesUseCase — provider-owned UI capability hints', () => {
    const useCase = build();

    describe('OpenAI', () => {
        it('gpt-5 family: rejects temperature, supports reasoning at medium/high', () => {
            const c = useCase.execute('openai', 'gpt-5.4');
            expect(c.temperature.kind).toBe('unsupported');
            expect(c.supportsReasoning).toBe(true);
            expect(c.reasoningOptions).toEqual(['medium', 'high']);
        });

        it('handles a gpt-5 variant id (gpt-5.6-sol) as a reasoner — no hand-coded list', () => {
            const c = useCase.execute('openai', 'gpt-5.6-sol');
            expect(c.temperature.kind).toBe('unsupported');
            expect(c.supportsReasoning).toBe(true);
            expect(c.reasoningOptions).toEqual(['medium', 'high']);
        });

        it('non-reasoning model (gpt-4o): accepts temperature, no reasoning', () => {
            const c = useCase.execute('openai', 'gpt-4o');
            expect(c.temperature.kind).toBe('adjustable');
            expect(c.supportsReasoning).toBe(false);
            expect(c.reasoningOptions).toEqual([]);
        });
    });

    describe('Anthropic (temperature policy owned by the module, not capabilities)', () => {
        it('4.7+ rejects temperature → unsupported', () => {
            const c = useCase.execute('anthropic', 'claude-opus-4-7');
            expect(c.temperature.kind).toBe('unsupported');
        });

        it('legacy 3.x accepts temperature → adjustable', () => {
            const c = useCase.execute(
                'anthropic',
                'claude-3-5-sonnet-20241022',
            );
            expect(c.temperature.kind).toBe('adjustable');
        });
    });

    describe('Anthropic-compatible brands (temperature policy derived from reasoning traits)', () => {
        it('Kimi k2.7-code is always-thinking → temperature FIXED at 1', () => {
            const c = useCase.execute('moonshot', 'kimi-k2.7-code');
            expect(c.temperature).toEqual({ kind: 'unsupported' });
        });

        it('Kimi k2.6 — thinking is disable-able, temperature still is not', () => {
            // The form used to render an enabled temperature field for k2.6
            // because it can turn thinking off. platform.kimi.ai: "temperature is
            // not modifiable, so no need to set it" — a property of the model in
            // every mode, unrelated to the thinking switch. An enabled field for
            // a value the model discards is the UI telling the user something
            // untrue.
            const c = useCase.execute('moonshot', 'kimi-k2.6');
            expect(c.temperature).toEqual({ kind: 'unsupported' });
        });

        it('Kimi k2.5 keeps an enabled temperature field — no source says otherwise', () => {
            // The scope line, asserted where the user can see it: an undocumented
            // sibling must not inherit the restriction and lose a working field.
            const c = useCase.execute('moonshot', 'kimi-k2.5');
            expect(c.temperature.kind).toBe('adjustable');
        });
    });

    describe('a capability that varies with the reasoning state', () => {
        // DeepSeek documents the constraint against thinking MODE, not the model:
        // "Thinking mode does not support the temperature, top_p, presence_penalty,
        // or frequency_penalty parameters". So the honest answer differs by state.
        //
        // Both answers travel in ONE response instead of the caller passing the
        // state in: that keeps this endpoint a pure function of (provider, model),
        // so it stays cacheable and flipping the toggle in the form costs nothing.
        it('sends BOTH answers for a model whose constraint is scoped to thinking', () => {
            const c = useCase.execute('openai_compatible', 'deepseek-v4-pro');
            expect(c.temperature).toEqual({ kind: 'unsupported' });
            expect(c.temperatureWhenReasoningOff).toEqual({ kind: 'adjustable' });
        });

        it('omits the second answer when it does not differ', () => {
            // Every other model — the response shape is unchanged for them, so
            // this costs nothing to the 99% case.
            const c = useCase.execute('openai_compatible', 'glm-5.2');
            expect(c.temperatureWhenReasoningOff).toBeUndefined();
        });

        it('does not offer an escape for an always-thinking model', () => {
            // k2.7-code has no off switch, so "reasoning off" never actually
            // stops it thinking — the second answer must NOT appear and unlock
            // the field. The verdict itself is now `unsupported` rather than a
            // pinned 1 (platform.kimi.ai documents its temperature as not
            // modifiable), but the property under test is the same one: no
            // reasoning state exists in which this field becomes editable.
            const c = useCase.execute('moonshot', 'kimi-k2.7-code');
            expect(c.temperature).toEqual({ kind: 'unsupported' });
            expect(c.temperatureWhenReasoningOff).toBeUndefined();
        });

        it('stays a pure function of (provider, model)', () => {
            // The regression guard for the shape itself: two identical calls must
            // be identical, with no hidden third input.
            expect(useCase.execute('openai_compatible', 'deepseek-v4-pro')).toEqual(
                useCase.execute('openai_compatible', 'deepseek-v4-pro'),
            );
        });
    });

    describe('the Custom-override example follows the MODEL, not the provider', () => {
        // Gemini 3 takes thinkingLevel and 2.5 takes thinkingBudget; Google
        // documents the two as completely incompatible. One example per provider
        // handed the 2.5 shape to every Gemini 3 user — 68 of the 91 production
        // Gemini slots.
        it('suggests thinkingLevel for a Gemini 3 model', () => {
            const c = useCase.execute(
                'google_gemini',
                'gemini-3-flash-preview',
            );
            expect(c.reasoningOverrideExample).toContain('thinkingLevel');
            expect(c.reasoningOverrideExample).not.toContain('thinkingBudget');
        });

        it('suggests thinkingBudget for a Gemini 2.5 model', () => {
            const c = useCase.execute('google_gemini', 'gemini-2.5-pro');
            expect(c.reasoningOverrideExample).toContain('thinkingBudget');
            expect(c.reasoningOverrideExample).not.toContain('thinkingLevel');
        });
    });

    describe('reasoningOverrideExample — the Custom-override JSON, owned by the module', () => {
        it('native OpenAI: reasoningEffort/serviceTier shape', () => {
            const c = useCase.execute('openai', 'gpt-5.4');
            expect(c.reasoningOverrideExample).toContain('reasoningEffort');
        });

        it('openai_compatible: the generic thinking shape (per requested id)', () => {
            const c = useCase.execute('openai_compatible', 'whatever');
            expect(c.reasoningOverrideExample).toContain('thinking');
            expect(c.reasoningOverrideExample).not.toContain('reasoningEffort');
        });

        it('Anthropic: adaptive thinking shape', () => {
            const c = useCase.execute('anthropic', 'claude-opus-4-7');
            expect(c.reasoningOverrideExample).toContain('adaptive');
        });

        it('OpenRouter: reasoning.effort shape', () => {
            const c = useCase.execute('open_router', 'anything');
            expect(c.reasoningOverrideExample).toContain('effort');
        });

        it('anthropic_compatible: legacy thinking WITH a budget (not the budget-less default)', () => {
            // Kimi/GLM/DeepSeek over the Anthropic protocol reject thinking
            // without a token budget, so the example must carry one.
            const c = useCase.execute('anthropic_compatible', 'kimi-k2.6');
            expect(c.reasoningOverrideExample).toContain('budgetTokens');
        });

        it('is undefined when the model ships no example (UI falls back)', () => {
            // A non-Anthropic Bedrock family reasons through no parameter this
            // transport can express, so it ships no override example.
            const c = useCase.execute('amazon_bedrock', 'minimax.minimax-m2');
            expect(c.reasoningOverrideExample).toBeUndefined();
        });
    });

    it('rejects an unsupported provider', () => {
        expect(() => build(false).execute('nope', 'x')).toThrow(
            /Unsupported provider/i,
        );
    });
});
