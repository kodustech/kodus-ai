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

// Fix 2 — the Test validates the configured tuning against the model's rules and
// returns a client error BEFORE any network round-trip, so a value the runtime
// would silently drop (an always-thinking Kimi ignores a non-1 temperature) fails
// the Test instead of saving quiet.
describe('TestByokConnectionUseCase — tuning validation short-circuits the probe', () => {
    beforeEach(() => {
        mockedAxios.post.mockReset();
        mockedAxios.get.mockReset();
        mockedAxios.post.mockResolvedValue({ status: 200, data: {} } as any);
        mockedAxios.get.mockResolvedValue({ status: 200, data: {} } as any);
    });

    it('kimi-k2.7-code + temperature 0.2 → bad_request, no HTTP call', async () => {
        const res = await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'kimi-k2.7-code',
            temperature: 0.2,
        });
        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(res.message).toContain('1');
        expect(mockedAxios.post).not.toHaveBeenCalled();
        expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('kimi-k2.7-code + reasoningEffort "none" → bad_request, no HTTP call', async () => {
        const res = await useCase().execute({
            provider: 'anthropic_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://api.moonshot.ai/anthropic',
            model: 'kimi-k2.7-code',
            reasoningEffort: 'none',
        });
        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('kimi-k2.7-code + temperature 1 (matches the pin) → proceeds to probe', async () => {
        const res = await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'kimi-k2.7-code',
            temperature: 1,
        });
        expect(res.ok).toBe(true);
        expect(mockedAxios.post).toHaveBeenCalled();
    });
});

// Fix 3 — the OpenAI-protocol chat providers (generic openai_compatible + Novita)
// exercise the model with a real 1-token chat completion carrying the RESOLVED
// temperature, instead of a GET /v1/models that some upstreams gate differently.
describe('TestByokConnectionUseCase — openai_compatible / novita real chat probe', () => {
    beforeEach(() => {
        mockedAxios.post.mockReset();
        mockedAxios.get.mockReset();
        mockedAxios.post.mockResolvedValue({ status: 200, data: {} } as any);
        mockedAxios.get.mockResolvedValue({ status: 200, data: {} } as any);
    });

    it('openai_compatible + model → POST /v1/chat/completions with a ping, not GET /models', async () => {
        const res = await useCase().execute({
            provider: 'openai_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://llm.example.com',
            model: 'some-model',
        });
        expect(res.ok).toBe(true);
        expect(mockedAxios.get).not.toHaveBeenCalled();
        const [url, body] = mockedAxios.post.mock.calls[0] as [string, any];
        expect(url).toBe('https://llm.example.com/v1/chat/completions');
        expect(body.model).toBe('some-model');
        expect(body.messages[0].content).toBe('ping');
    });

    it('novita + model → POST to novita chat endpoint (no baseURL needed)', async () => {
        const res = await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'meta-llama/llama-3-70b',
        });
        expect(res.ok).toBe(true);
        const [url] = mockedAxios.post.mock.calls[0] as [string];
        expect(url).toBe(
            'https://api.novita.ai/v3/openai/chat/completions',
        );
    });

    it('always-thinking kimi on novita sends the resolved fixed temperature (1)', async () => {
        // No temperature configured → passes validation → runtime resolves the
        // family pin (1) → the probe sends exactly what a review would.
        await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'kimi-k2.7-code',
        });
        const [, body] = mockedAxios.post.mock.calls[0] as [string, any];
        expect(body.temperature).toBe(1);
    });

    it('a base URL already carrying /v1 is not double-suffixed', async () => {
        await useCase().execute({
            provider: 'openai_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://llm.example.com/v1',
            model: 'some-model',
        });
        const [url] = mockedAxios.post.mock.calls[0] as [string];
        expect(url).toBe('https://llm.example.com/v1/chat/completions');
    });

    it('openai_compatible with NO model still falls back to GET /models', async () => {
        const res = await useCase().execute({
            provider: 'openai_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://llm.example.com',
        });
        expect(res.ok).toBe(true);
        expect(mockedAxios.get).toHaveBeenCalled();
        expect(mockedAxios.post).not.toHaveBeenCalled();
    });
});
