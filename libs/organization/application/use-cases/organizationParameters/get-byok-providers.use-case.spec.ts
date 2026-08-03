import { GetByokProvidersUseCase } from './get-byok-providers.use-case';

/**
 * The use-case is a pure descriptor over the process-wide provider REGISTRY
 * (populated by the '@libs/llm/providers' barrel's self-registration side
 * effect). No deps, no org data, no secrets — so the spec just asserts the
 * registered providers surface with a label.
 */
describe('GetByokProvidersUseCase', () => {
    const useCase = new GetByokProvidersUseCase();

    it('returns the registered providers, each with a non-empty label', async () => {
        const { providers } = await useCase.execute();

        expect(providers.length).toBeGreaterThan(0);
        for (const p of providers) {
            expect(typeof p.id).toBe('string');
            expect(p.id.length).toBeGreaterThan(0);
            expect(typeof p.label).toBe('string');
            expect(p.label.length).toBeGreaterThan(0);
            expect(Array.isArray(p.aliases)).toBe(true);
        }
    });

    it('includes the core providers and the registry-only ones (bedrock)', async () => {
        const { providers } = await useCase.execute();
        const ids = providers.map((p) => p.id);

        // Core providers that also have curated models.
        expect(ids).toContain('openai');
        expect(ids).toContain('anthropic');
        // Registry-only provider with NO curated-models.json entry — the whole
        // point of the registry-driven list (bedrock.module.ts id).
        expect(ids).toContain('amazon_bedrock');
    });

    it('exposes aliases so a module can flatten to multiple connectable ids', async () => {
        const { providers } = await useCase.execute();
        const anthropic = providers.find((p) => p.id === 'anthropic');

        expect(anthropic).toBeDefined();
        expect(anthropic?.aliases).toContain('anthropic_compatible');
    });
});
