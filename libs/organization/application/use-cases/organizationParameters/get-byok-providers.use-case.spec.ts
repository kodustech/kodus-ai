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

    it('flags autoListModels per the module listing (drives the picker subtitle)', async () => {
        const { providers } = await useCase.execute();
        const by = (id: string) => providers.find((p) => p.id === id);

        // http listing at a fixed models endpoint → listable (curated brand that
        // still exposes a live model list — powers "Browse all models").
        expect(by('moonshot')?.autoListModels).toBe(true);
        // static catalog → listable without a live call.
        expect(by('amazon_bedrock')?.autoListModels).toBe(true);
        // curated http provider → listable.
        expect(by('openai')?.autoListModels).toBe(true);
        // every descriptor carries the boolean flag.
        for (const p of providers) {
            expect(typeof p.autoListModels).toBe('boolean');
        }
    });
});

describe('GetByokProvidersUseCase — Kodus provider private alpha', () => {
    it('hides `kodus` when no gate is wired (dependency-free descriptor stays closed)', async () => {
        const { providers } = await new GetByokProvidersUseCase().execute('org-1');
        expect(providers.map((p) => p.id)).not.toContain('kodus');
    });

    it('hides `kodus` for an org the gate refuses and shows it for one it allows', async () => {
        const gate = { isEnabledFor: jest.fn(async (org?: string) => org === 'org-alpha') };
        const off = await new GetByokProvidersUseCase(gate as any).execute('org-other');
        expect(off.providers.map((p) => p.id)).not.toContain('kodus');
        const on = await new GetByokProvidersUseCase(gate as any).execute('org-alpha');
        expect(on.providers.map((p) => p.id)).toContain('kodus');
        expect(gate.isEnabledFor).toHaveBeenCalledWith('org-alpha');
        // Every other provider is unaffected by the gate.
        expect(off.providers.map((p) => p.id)).toEqual(
            on.providers.map((p) => p.id).filter((id) => id !== 'kodus'),
        );
    });
});
