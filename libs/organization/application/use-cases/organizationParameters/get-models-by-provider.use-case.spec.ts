import axios from 'axios';
import { BYOKProvider } from '@kodus/kodus-common/llm';

import { GetModelsByProviderUseCase } from './get-models-by-provider.use-case';

jest.mock('axios');
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => `decrypted:${v}`,
}));
// The SSRF guard does a real DNS lookup — stub it so the catalog tests don't
// depend on network / public DNS resolution.
jest.mock('./test-byok-connection.use-case', () => ({
    assertSafeOpenAICompatibleUrl: jest.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function buildUseCase(configValue: unknown) {
    const providerService = { isProviderSupported: () => true } as any;
    const orgParamsService = {
        findByKey: jest.fn().mockResolvedValue(
            configValue ? { configValue } : null,
        ),
    } as any;
    return new GetModelsByProviderUseCase(providerService, orgParamsService);
}

describe('GetModelsByProviderUseCase — BYOK-aware model listing', () => {
    beforeEach(() => {
        mockedAxios.get.mockReset();
        mockedAxios.get.mockResolvedValue({
            data: { object: 'list', data: [{ id: 'kimi-k2.7-code' }] },
        } as any);
    });

    it('lists openai_compatible against the org\'s OWN baseURL + decrypted key', async () => {
        const useCase = buildUseCase({
            main: {
                provider: 'openai_compatible',
                apiKey: 'enc-key',
                baseURL: 'https://api.moonshot.ai/v1',
                model: 'kimi-k2.7-code',
            },
        });

        const res = await useCase.execute('openai_compatible', {
            organizationId: 'org-1',
        });

        expect(res.models.map((m) => m.id)).toContain('kimi-k2.7-code');
        const [url, cfg] = mockedAxios.get.mock.calls[0];
        // baseURL already ends in /v1 → must NOT double it.
        expect(url).toBe('https://api.moonshot.ai/v1/models');
        expect(cfg?.headers?.Authorization).toBe('Bearer decrypted:enc-key');
    });

    it('matches the fallback slot when the requested provider is the fallback', async () => {
        const useCase = buildUseCase({
            main: { provider: 'openai_compatible', apiKey: 'm', baseURL: 'https://a' },
            fallback: {
                provider: 'google_gemini',
                apiKey: 'enc-gem',
                model: 'gemini-x',
            },
        });

        mockedAxios.get.mockResolvedValue({
            data: { models: [{ name: 'models/gemini-x', supportedGenerationMethods: [] }] },
        } as any);

        await useCase.execute('google_gemini', { organizationId: 'org-1' });
        const [, cfg] = mockedAxios.get.mock.calls[0];
        expect(cfg?.headers?.['x-goog-api-key']).toBe('decrypted:enc-gem');
    });

    it('falls back to env when the org has no matching saved slot', async () => {
        process.env.API_OPENAI_FORCE_BASE_URL = '';
        const useCase = buildUseCase(null);

        await useCase.execute('openai_compatible', { organizationId: 'org-1' });
        const [url] = mockedAxios.get.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/models');
    });

    it('falls back to env when there is no org context (setup wizard)', async () => {
        const useCase = buildUseCase({
            main: { provider: 'openai_compatible', apiKey: 'm', baseURL: 'https://a' },
        });

        await useCase.execute('openai_compatible');
        expect(
            (useCase as any).organizationParametersService.findByKey,
        ).not.toHaveBeenCalled();
    });
});
