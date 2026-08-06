import { azureModule } from './index';
import { REGISTRY } from '../kernel/registry';
import type { ProviderBuildConfig } from '../kernel/types';

const cfg = (over: Partial<ProviderBuildConfig> = {}): ProviderBuildConfig =>
    ({
        provider: 'azure',
        apiKey: 'plain-key',
        model: 'my-gpt4o-deployment',
        baseURL: 'https://acme.openai.azure.com/openai',
        ...over,
    }) as ProviderBuildConfig;

describe('azure provider module', () => {
    it('self-registers under the "azure" id', () => {
        expect(REGISTRY.has('azure')).toBe(true);
        expect(REGISTRY.get('azure')).toBe(azureModule);
    });

    it('builds a LanguageModel from the deployment (slot.model) + resource baseURL', () => {
        const model = azureModule.build(cfg());
        // The AI SDK model exposes a modelId; for azure it is the deployment name.
        expect((model as { modelId?: string }).modelId).toBe(
            'my-gpt4o-deployment',
        );
    });

    it('advertises OpenAI-family capabilities (json_schema + native tools + caching)', () => {
        const caps = azureModule.capabilities('gpt-4o');
        expect(caps.structuredOutput).toBe('json_schema');
        expect(caps.toolCalling).toBe('native');
        expect(caps.promptCaching).toBe(true);
    });

    it('best-effort disables temperature for a reasoning-named deployment', () => {
        expect(azureModule.capabilities('o1-mini').supportsTemperature).toBe(
            false,
        );
        expect(azureModule.capabilities('gpt-4o').supportsTemperature).toBe(
            true,
        );
    });

    it('does NOT emit a system cache hint (Azure caches implicitly, like OpenAI)', () => {
        // The cache design: promptCaching true, but no inline systemCacheControl.
        expect(azureModule.systemCacheControl).toBeUndefined();
    });

    it('lists models manually (deployments are not enumerable via the inference key)', () => {
        expect(azureModule.modelListing?.('azure')).toEqual({ kind: 'manual' });
    });
});
