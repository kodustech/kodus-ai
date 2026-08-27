import axios from 'axios';
import { BYOKProvider } from '@libs/llm/model-providers';

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
        findByKey: jest
            .fn()
            .mockResolvedValue(configValue ? { configValue } : null),
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

    it("lists openai_compatible against the org's OWN baseURL + decrypted key", async () => {
        const useCase = buildUseCase({
            version: 2,
            credentials: [
                {
                    id: 'c1',
                    provider: 'openai_compatible',
                    apiKey: 'enc-key',
                    settings: { baseURL: 'https://api.moonshot.ai/v1' },
                },
            ],
            models: [{ id: 'm1', credentialId: 'c1', model: 'kimi-k2.7-code' }],
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

    it('matches the credential for the requested provider', async () => {
        const useCase = buildUseCase({
            version: 2,
            credentials: [
                {
                    id: 'c1',
                    provider: 'openai_compatible',
                    apiKey: 'm',
                    settings: { baseURL: 'https://a' },
                },
                { id: 'c2', provider: 'google_gemini', apiKey: 'enc-gem' },
            ],
            models: [{ id: 'm1', credentialId: 'c2', model: 'gemini-x' }],
        });

        mockedAxios.get.mockResolvedValue({
            data: {
                models: [
                    { name: 'models/gemini-x', supportedGenerationMethods: [] },
                ],
            },
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
            main: {
                provider: 'openai_compatible',
                apiKey: 'm',
                baseURL: 'https://a',
            },
        });

        await useCase.execute('openai_compatible');
        expect(
            (useCase as any).organizationParametersService.findByKey,
        ).not.toHaveBeenCalled();
    });

    // ---- registry-driven descriptor branches (Phase 2) ----

    it('serves a curated static catalog without any HTTP call (Bedrock)', async () => {
        const useCase = buildUseCase(null);

        const res = await useCase.execute(BYOKProvider.AMAZON_BEDROCK, {
            organizationId: 'org-1',
        });

        expect(res.models.length).toBeGreaterThan(0);
        expect(res.models.some((m) => m.id.includes('anthropic'))).toBe(true);
        expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('rejects manual-only providers with a "enter the model ID" message', async () => {
        const useCase = buildUseCase(null);

        await expect(
            useCase.execute(BYOKProvider.ANTHROPIC_COMPATIBLE, {
                organizationId: 'org-1',
            }),
        ).rejects.toThrow(/enter the model ID manually/i);
        expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('lists Moonshot against its FIXED models endpoint, ignoring the stored chat baseURL', async () => {
        // A saved key drives the LIVE listing (a keyless connect now degrades to
        // the curated catalog instead). The stored chat baseURL must be IGNORED —
        // the models call hits Moonshot's fixed OpenAI-protocol endpoint.
        const useCase = buildUseCase({
            version: 2,
            credentials: [
                {
                    id: 'c1',
                    provider: 'moonshot',
                    apiKey: 'enc-moon',
                    settings: { baseURL: 'https://api.moonshot.ai/anthropic' },
                },
            ],
            models: [{ id: 'm1', credentialId: 'c1', model: 'kimi-k2.7-code' }],
        });

        const res = await useCase.execute(BYOKProvider.MOONSHOT, {
            organizationId: 'org-1',
        });

        expect(res.models.map((m) => m.id)).toContain('kimi-k2.7-code');
        // Fixed OpenAI-protocol models endpoint — NOT derived from the Anthropic
        // chat baseURL the brand builds over.
        const [url] = mockedAxios.get.mock.calls[0];
        expect(url).toBe('https://api.moonshot.ai/v1/models');
    });

    // ---- candidate (just-typed, unsaved) key — the connect form ----

    it('lists OpenAI live with a JUST-TYPED candidate key, verbatim (no decrypt, no curated placeholder)', async () => {
        mockedAxios.get.mockResolvedValue({
            data: {
                object: 'list',
                data: [{ id: 'gpt-5.4' }, { id: 'gpt-4o' }],
            },
        } as any);
        const useCase = buildUseCase(null); // no saved config

        const res = await useCase.execute(
            BYOKProvider.OPENAI,
            { organizationId: 'org-1' },
            { apiKey: 'sk-typed' },
        );

        // The LIVE list — includes gpt-4o, which the curated catalog does NOT ship.
        expect(res.models.map((m) => m.id)).toEqual(
            expect.arrayContaining(['gpt-4o']),
        );
        const [url, cfg] = mockedAxios.get.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/models');
        // Candidate key is plaintext — sent verbatim, never run through decrypt.
        expect(cfg?.headers?.Authorization).toBe('Bearer sk-typed');
    });

    it('is STRICT with a candidate key: a live-fetch failure throws instead of the curated fallback', async () => {
        mockedAxios.get.mockRejectedValue(new Error('401 Unauthorized'));
        const useCase = buildUseCase(null);

        await expect(
            useCase.execute(
                BYOKProvider.OPENAI,
                { organizationId: 'org-1' },
                { apiKey: 'sk-bad' },
            ),
        ).rejects.toThrow(/Error fetching openai models/i);
    });

    it('keyless OpenAI (no candidate, no saved slot, no env) still attempts the live listing — no curated stand-in', async () => {
        const prev = process.env.API_OPEN_AI_API_KEY;
        delete process.env.API_OPEN_AI_API_KEY;
        const useCase = buildUseCase(null);

        // The curated catalog is gone: there is no model list to degrade to, so the
        // live `/models` call is attempted (and, keyless, would surface an auth
        // error the UI turns into manual entry). No short-circuit to a static set.
        await useCase.execute(BYOKProvider.OPENAI, { organizationId: 'org-1' });

        expect(mockedAxios.get).toHaveBeenCalled();
        if (prev !== undefined) process.env.API_OPEN_AI_API_KEY = prev;
    });

    it('a manual-listing BRAND (Z.ai/GLM) can no longer be enumerated — the user types the model id', async () => {
        // Z.ai speaks the Anthropic protocol → no `/models` call (manual listing),
        // and there is no curated catalog to stand in. The picker falls back to
        // manual model-id entry, so the use-case reports that plainly.
        const useCase = buildUseCase(null);

        await expect(
            useCase.execute('zai' as any, { organizationId: 'org-1' }),
        ).rejects.toThrow(/enter the model ID manually/);
        expect(mockedAxios.get).not.toHaveBeenCalled();
    });
});
