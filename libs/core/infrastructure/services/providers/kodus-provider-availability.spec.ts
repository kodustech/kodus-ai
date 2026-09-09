/**
 * The cloud-only gate for the `kodus` provider, as every org-layer surface sees
 * it. `environment` is compiled-in, so it is mocked per describe.
 */
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

import { environment } from '@libs/ee/configs/environment';
import { GetByokProvidersUseCase } from '@libs/organization/application/use-cases/organizationParameters/get-byok-providers.use-case';
import {
    isKodusProviderAvailable,
    isProviderAvailableHere,
} from './kodus-provider-availability';
import { ProviderService } from './provider.service';

const setCloud = (on: boolean) => {
    (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = on;
};

describe('kodus provider availability', () => {
    afterEach(() => setCloud(true));

    it('is available on cloud and hidden on self-hosted; other ids are never gated', () => {
        setCloud(true);
        expect(isKodusProviderAvailable()).toBe(true);
        expect(isProviderAvailableHere('kodus')).toBe(true);
        expect(isProviderAvailableHere('openai')).toBe(true);

        setCloud(false);
        expect(isKodusProviderAvailable()).toBe(false);
        expect(isProviderAvailableHere('kodus')).toBe(false);
        expect(isProviderAvailableHere('openai')).toBe(true);
    });

    it('ProviderService projects kodus as keyless + auto-listable on cloud', () => {
        setCloud(true);
        const service = new ProviderService();
        expect(service.isProviderSupported('kodus')).toBe(true);
        expect(service.getProvider('kodus')).toMatchObject({
            requiresApiKey: false,
            requiresBaseUrl: false,
            autoListModels: true,
            listsModelsLive: false,
        });
    });

    it('ProviderService drops kodus entirely on self-hosted (listing/probe/save refuse it)', () => {
        setCloud(false);
        const service = new ProviderService();
        expect(service.isProviderSupported('kodus')).toBe(false);
        expect(service.getProvider('kodus')).toBeNull();
        expect(service.getAllProviders().map((p) => p.id)).not.toContain('kodus');
        // Everyone else is untouched.
        expect(service.isProviderSupported('anthropic')).toBe(true);
    });

    it('GetByokProvidersUseCase lists kodus only on cloud', async () => {
        const useCase = new GetByokProvidersUseCase();
        setCloud(true);
        expect((await useCase.execute()).providers.map((p) => p.id)).toContain('kodus');
        setCloud(false);
        expect((await useCase.execute()).providers.map((p) => p.id)).not.toContain('kodus');
    });
});
