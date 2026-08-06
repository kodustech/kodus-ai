import { ProviderService } from './provider.service';

/**
 * ProviderService is a pure projection of the process-wide provider REGISTRY
 * (populated by the '@libs/llm/providers' barrel's self-registration side
 * effect). These tests lock in the registry-driven behavior — the fix for the
 * old hardcoded list that SHADOWED registered providers (Moonshot was missing,
 * so isProviderSupported('moonshot') was false and the model listing 400'd).
 */
describe('ProviderService — registry-driven', () => {
    const service = new ProviderService();

    it('supports every registered provider, including registry-only Moonshot', () => {
        // The regression that motivated the refactor: Moonshot is a real registry
        // module but was absent from the old hardcoded Record → "Unsupported
        // provider: moonshot" on the model-listing gate.
        expect(service.isProviderSupported('moonshot')).toBe(true);
        expect(service.isProviderSupported('amazon_bedrock')).toBe(true);
        expect(service.isProviderSupported('google_vertex')).toBe(true);
        expect(service.isProviderSupported('openai')).toBe(true);
    });

    it('reports an unknown provider as unsupported', () => {
        expect(service.isProviderSupported('does_not_exist')).toBe(false);
        expect(service.getProvider('does_not_exist')).toBeNull();
    });

    it('lists providers with unique ids and non-empty names', () => {
        const providers = service.getAllProviders();
        expect(providers.length).toBeGreaterThan(0);

        const ids = providers.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length); // no duplicates
        for (const p of providers) {
            expect(p.name.length).toBeGreaterThan(0);
            expect(p.supported).toBe(true);
        }
    });

    describe('derived flags', () => {
        const byId = (id: string) => {
            const p = new ProviderService().getProvider(id);
            expect(p).not.toBeNull();
            return p!;
        };

        it('Moonshot: needs a key, NOT a base URL (has a default), and lists models', () => {
            const m = byId('moonshot');
            expect(m.name).toBe('Moonshot');
            expect(m.requiresApiKey).toBe(true);
            // Has a defaultBaseURL (api.moonshot.ai/v1) → the user must NOT be
            // forced to type one, and the model list can be auto-fetched.
            expect(m.requiresBaseUrl).toBe(false);
            expect(m.autoListModels).toBe(true);
        });

        it('Bedrock: no API key field (AWS creds), static catalog is listable', () => {
            const b = byId('amazon_bedrock');
            expect(b.requiresApiKey).toBe(false);
            expect(b.autoListModels).toBe(true);
        });

        it('Vertex: static catalog is listable', () => {
            expect(byId('google_vertex').autoListModels).toBe(true);
        });

        it('OpenAI-compatible (alias): custom endpoint — needs base URL, not auto-listable', () => {
            const c = byId('openai_compatible');
            expect(c.name).toBe('OpenAI Compatible');
            expect(c.requiresBaseUrl).toBe(true);
            expect(c.autoListModels).toBe(false);
        });

        it('Anthropic-compatible (alias): manual listing — distinct label, not auto-listable', () => {
            const c = byId('anthropic_compatible');
            expect(c.name).toBe('Anthropic Compatible');
            expect(c.autoListModels).toBe(false);
        });

        it('Azure: native id, but its required per-resource endpoint field forces requiresBaseUrl', () => {
            const a = byId('azure');
            expect(a.requiresApiKey).toBe(true);
            // Not a *_compatible id and its listing is `manual` (not http), so the
            // ONLY signal is the module's required `baseURL` uiField. Without honoring
            // that, the connect form would omit the resource-endpoint input and Azure
            // would be selectable-but-unusable.
            expect(a.requiresBaseUrl).toBe(true);
        });
    });

    it('validateProviderConfig enforces the derived requirements', () => {
        // openai_compatible requires a base URL; missing one is invalid.
        const missingUrl = service.validateProviderConfig('openai_compatible', {
            apiKey: 'sk-x',
        });
        expect(missingUrl.isValid).toBe(false);
        expect(missingUrl.errors.join(' ')).toMatch(/base url/i);

        // Moonshot needs only a key (default base URL applies).
        const ok = service.validateProviderConfig('moonshot', { apiKey: 'sk-x' });
        expect(ok.isValid).toBe(true);
    });
});
