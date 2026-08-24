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
            expect(c.supportsTemperature).toBe(false);
            expect(c.supportsReasoning).toBe(true);
            expect(c.reasoningOptions).toEqual(['medium', 'high']);
        });

        it('handles a gpt-5 variant id (gpt-5.6-sol) as a reasoner — no hand-coded list', () => {
            const c = useCase.execute('openai', 'gpt-5.6-sol');
            expect(c.supportsTemperature).toBe(false);
            expect(c.supportsReasoning).toBe(true);
            expect(c.reasoningOptions).toEqual(['medium', 'high']);
        });

        it('non-reasoning model (gpt-4o): accepts temperature, no reasoning', () => {
            const c = useCase.execute('openai', 'gpt-4o');
            expect(c.supportsTemperature).toBe(true);
            expect(c.supportsReasoning).toBe(false);
            expect(c.reasoningOptions).toEqual([]);
        });
    });

    describe('Anthropic (temperature answer comes from supportsSamplingParams, not capabilities)', () => {
        it('4.7+ rejects temperature', () => {
            const c = useCase.execute('anthropic', 'claude-opus-4-7');
            expect(c.supportsTemperature).toBe(false);
        });

        it('legacy 3.x accepts temperature', () => {
            const c = useCase.execute('anthropic', 'claude-3-5-sonnet-20241022');
            expect(c.supportsTemperature).toBe(true);
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

        it('is undefined when the module ships no example (UI falls back)', () => {
            // anthropic_compatible intentionally has no brand example.
            const c = useCase.execute('anthropic_compatible', 'x');
            expect(c.reasoningOverrideExample).toBeUndefined();
        });
    });

    it('rejects an unsupported provider', () => {
        expect(() => build(false).execute('nope', 'x')).toThrow(
            /Unsupported provider/i,
        );
    });
});
