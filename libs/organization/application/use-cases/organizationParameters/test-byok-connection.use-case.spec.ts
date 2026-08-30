import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import type { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
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

describe('TestByokConnectionUseCase ChatGPT subscription', () => {
    const providerService = {
        isProviderSupported: jest.fn().mockReturnValue(true),
    };

    it('tests token credentials without requiring apiKey', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue(
            new Response('data: [DONE]\n\n', {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        ) as typeof fetch;
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );

        try {
            await expect(
                useCase.execute({
                    provider: 'chatgpt_subscription',
                    codexAccessToken: 'access-token',
                    codexRefreshToken: 'refresh-token',
                    accountId: 'account-id',
                    model: 'gpt-5.6-luna',
                }),
            ).resolves.toMatchObject({ ok: true, code: 'ok', httpStatus: 200 });
            expect(global.fetch).toHaveBeenCalledWith(
                'https://chatgpt.com/backend-api/codex/responses',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer access-token',
                        'chatgpt-account-id': 'account-id',
                    }),
                }),
            );
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('classifies a 401 response as an authentication failure', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue(
            new Response('{"error":{"message":"expired token"}}', {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            }),
        ) as typeof fetch;
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );

        try {
            await expect(
                useCase.execute({
                    provider: 'chatgpt_subscription',
                    codexAccessToken: 'expired-access-token',
                    codexRefreshToken: 'refresh-token',
                    accountId: 'account-id',
                }),
            ).resolves.toMatchObject({
                ok: false,
                code: 'auth',
                httpStatus: 401,
            });
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('classifies an AbortSignal timeout as a network failure, not unknown', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(
            new DOMException(
                'The operation was aborted due to timeout',
                'TimeoutError',
            ),
        ) as typeof fetch;
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );

        try {
            await expect(
                useCase.execute({
                    provider: 'chatgpt_subscription',
                    codexAccessToken: 'access-token',
                    codexRefreshToken: 'refresh-token',
                    accountId: 'account-id',
                }),
            ).resolves.toMatchObject({
                ok: false,
                code: 'network',
            });
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('rejects incomplete token credentials before making a request', async () => {
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );
        await expect(
            useCase.execute({
                provider: 'chatgpt_subscription',
                codexAccessToken: 'access-token',
                accountId: 'account-id',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sends the Codex input as a Responses message array', async () => {
        // A bare string is rejected by the live endpoint with
        // `{"detail":"Input must be a list"}`, which a mocked fetch cannot
        // surface, so this asserts the wire shape directly.
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue(
            new Response('data: [DONE]\n\n', {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        ) as typeof fetch;
        const useCase = new TestByokConnectionUseCase(
            providerService as unknown as ProviderService,
        );

        try {
            await useCase.execute({
                provider: 'chatgpt_subscription',
                codexAccessToken: 'access-token',
                codexRefreshToken: 'refresh-token',
                accountId: 'account-id',
                model: 'gpt-5.6-sol',
            });
            const call = (global.fetch as jest.Mock).mock.calls[0];
            const body = JSON.parse(call[1].body);
            expect(Array.isArray(body.input)).toBe(true);
            expect(body.input[0]).toMatchObject({
                type: 'message',
                role: 'user',
            });
        } finally {
            global.fetch = originalFetch;
        }
    });
});
