/**
 * Regression + contract: a key-only connect to an Anthropic-protocol BRAND
 * (Kimi/GLM, and any future one) must resolve the brand's canonical endpoint on
 * its own — the connect form carries no baseURL for a curated brand.
 *
 * Why this file exists: removing the curated catalog dropped `defaults.baseURL`,
 * and the connection probe — which had NO test — started throwing "baseURL is
 * required for moonshot". The coupling was indirect (catalog → web form → request
 * baseURL → probe), so a grep for direct `defaults.baseURL` readers missed it.
 * The endpoint now lives on the provider module (`defaultBaseURL`); this sweeps
 * EVERY brand that declares one, so a new brand is covered automatically and this
 * whole class of regression can't come back silently.
 */
import axios from 'axios';
import { REGISTRY } from '@libs/llm/providers';
import { TestByokConnectionUseCase } from './test-byok-connection.use-case';

jest.mock('axios');
// SSRF guard resolves the host via dns/promises — stub it to a public IP so the
// probe doesn't depend on real DNS.
jest.mock('dns/promises', () => ({
    lookup: jest.fn().mockResolvedValue([{ address: '203.0.113.10', family: 4 }]),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function useCase() {
    const providerService = { isProviderSupported: () => true } as any;
    return new TestByokConnectionUseCase(providerService);
}

// Every brand that declares a canonical endpoint — the exact set whose key-only
// connect depends on the module supplying baseURL. Derived from the registry, so
// a new brand joins this matrix the moment it ships.
const BRANDS_WITH_ENDPOINT = REGISTRY.all()
    .filter((m) => typeof m.defaultBaseURL === 'string' && m.defaultBaseURL)
    .map((m) => [m.id, m.defaultBaseURL as string] as const);

describe('brands expose their canonical endpoint on the module', () => {
    it('at least the two Anthropic-protocol brands are present', () => {
        const ids = BRANDS_WITH_ENDPOINT.map(([id]) => id);
        expect(ids).toEqual(expect.arrayContaining(['moonshot', 'zai']));
    });

    it.each(BRANDS_WITH_ENDPOINT)(
        '%s → defaultBaseURL is a valid https URL',
        (_id, baseURL) => {
            expect(() => new URL(baseURL)).not.toThrow();
            expect(baseURL.startsWith('https://')).toBe(true);
        },
    );
});

describe('TestByokConnectionUseCase — key-only brand connect resolves the endpoint', () => {
    beforeEach(() => {
        mockedAxios.post.mockReset();
        mockedAxios.get.mockReset();
        mockedAxios.post.mockResolvedValue({ status: 200, data: {} } as any);
        mockedAxios.get.mockResolvedValue({ status: 200, data: {} } as any);
    });

    // The regression itself, swept over every brand: a key + NO baseURL must probe
    // the brand's own host, never throw "baseURL is required".
    it.each(BRANDS_WITH_ENDPOINT)(
        '%s: key-only (no baseURL) probes its own host, no 400',
        async (id, baseURL) => {
            const res = await useCase().execute({
                provider: id,
                apiKey: 'sk-test',
                model: 'some-model',
            });

            expect(res.ok).toBe(true);
            const calledUrl = (mockedAxios.post.mock.calls[0]?.[0] ??
                mockedAxios.get.mock.calls[0]?.[0]) as string;
            expect(calledUrl).toContain(new URL(baseURL).host);
        },
    );

    it('a generic anthropic_compatible (no brand endpoint) still requires baseURL', async () => {
        await expect(
            useCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-test',
            }),
        ).rejects.toThrow(/baseURL is required/i);
    });
});
