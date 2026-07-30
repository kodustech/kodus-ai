import {
    anthropicCompatibleRootURL,
    BYOKProvider,
    getAdapter,
} from '@kodus/kodus-common/llm';

// Encryption is irrelevant here — deterministic reversible stand-in so
// byokToVercelModel can decrypt the stored key without a real crypto env.
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (value: string) => `enc(${value})`,
    decrypt: (value: string) => value.replace(/^enc\(|\)$/g, ''),
}));

import { byokToVercelModel } from '@libs/llm/byok-to-vercel';
import {
    buildReasoningProviderOptions,
    EFFORT_TO_BUDGET,
} from '@libs/llm/reasoning-options';
import { TestByokConnectionUseCase } from '@libs/organization/application/use-cases/organizationParameters/test-byok-connection.use-case';
import axios from 'axios';

describe('anthropic_compatible BYOK provider', () => {
    describe('anthropicCompatibleRootURL', () => {
        it.each([
            ['https://api.kimi.com/coding', 'https://api.kimi.com/coding'],
            ['https://api.kimi.com/coding/', 'https://api.kimi.com/coding'],
            ['https://api.kimi.com/coding/v1', 'https://api.kimi.com/coding'],
            ['https://api.kimi.com/coding/v1/', 'https://api.kimi.com/coding'],
            ['https://api.z.ai/api/anthropic', 'https://api.z.ai/api/anthropic'],
            [' https://api.deepseek.com/anthropic ', 'https://api.deepseek.com/anthropic'],
        ])('normalizes %s → %s', (input, expected) => {
            expect(anthropicCompatibleRootURL(input)).toBe(expected);
        });
    });

    describe('LangChain adapter routing', () => {
        it('routes anthropic_compatible to the Anthropic adapter with a root anthropicApiUrl', () => {
            const adapter = getAdapter('anthropic_compatible');
            const model = adapter.build({
                model: 'kimi-for-coding',
                apiKey: 'sk-kimi-test',
                baseURL: 'https://api.kimi.com/coding/v1',
            });

            // ChatAnthropic appends /v1/messages itself — the configured
            // URL must be the root, not the /v1-suffixed base.
            expect(model.constructor.name).toBe('ChatAnthropic');
            expect((model as any).apiUrl).toBe('https://api.kimi.com/coding');
        });
    });

    describe('reasoning provider options', () => {
        // These pin a non-obvious contract that a future refactor merging the
        // ANTHROPIC and ANTHROPIC_COMPATIBLE cases could silently break:
        // third-party Anthropic-protocol vendors (Kimi/Z.ai/DeepSeek) must use
        // the `anthropic` namespace with the *budget* thinking shape. The
        // `openaiCompatible` namespace would be dropped by @ai-sdk/anthropic
        // (reasoning silently off); the `adaptive` shape would 400 because
        // these vendors don't implement Anthropic's adaptive thinking.
        it('routes reasoning to the anthropic namespace with a budget shape', () => {
            const opts = buildReasoningProviderOptions(
                BYOKProvider.ANTHROPIC_COMPATIBLE,
                'medium',
                'kimi-for-coding',
            );

            expect(opts).toEqual({
                anthropic: {
                    thinking: {
                        type: 'enabled',
                        budgetTokens: EFFORT_TO_BUDGET.medium,
                    },
                },
            });
            // Guard against the two silent-failure modes explicitly:
            expect(opts).not.toHaveProperty('openaiCompatible');
            expect((opts as any).anthropic?.thinking?.type).not.toBe('adaptive');
        });

        it('turns thinking off for effort "none"', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC_COMPATIBLE,
                    'none',
                    'kimi-for-coding',
                ),
            ).toEqual({});
        });
    });

    describe('Vercel AI SDK routing', () => {
        it('maps anthropic_compatible to an anthropic model with a /v1-suffixed base', () => {
            const model = byokToVercelModel({
                main: {
                    provider: BYOKProvider.ANTHROPIC_COMPATIBLE,
                    apiKey: 'enc(sk-kimi-test)',
                    model: 'kimi-for-coding',
                    baseURL: 'https://api.kimi.com/coding',
                },
            } as any);

            expect((model as any).modelId).toBe('kimi-for-coding');
            // @ai-sdk/anthropic exposes the provider name on the model.
            expect((model as any).provider).toMatch(/anthropic/i);
        });
    });

    describe('TestByokConnectionUseCase', () => {
        const buildUseCase = () =>
            new TestByokConnectionUseCase({
                isProviderSupported: jest.fn().mockReturnValue(true),
            } as any);

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('rejects anthropic_compatible without a baseURL', async () => {
            await expect(
                buildUseCase().execute({
                    provider: 'anthropic_compatible',
                    apiKey: 'sk-kimi-test',
                }),
            ).rejects.toThrow(/baseURL is required for anthropic_compatible/);
        });

        it('probes the real /v1/messages endpoint when a model is provided', async () => {
            const post = jest
                .spyOn(axios, 'post')
                .mockResolvedValue({ status: 200, data: {} });

            const result = await buildUseCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-kimi-test',
                baseURL: 'https://api.kimi.com/coding/v1',
                model: 'kimi-for-coding',
            });

            expect(result.ok).toBe(true);
            expect(post).toHaveBeenCalledWith(
                'https://api.kimi.com/coding/v1/messages',
                expect.objectContaining({
                    model: 'kimi-for-coding',
                    max_tokens: 1,
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'x-api-key': 'sk-kimi-test',
                        'anthropic-version': '2023-06-01',
                    }),
                }),
            );
        });

        it('falls back to GET /v1/models when no model is provided', async () => {
            const get = jest
                .spyOn(axios, 'get')
                .mockResolvedValue({ status: 200, data: { data: [] } });

            const result = await buildUseCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-kimi-test',
                baseURL: 'https://api.kimi.com/coding',
            });

            expect(result.ok).toBe(true);
            expect(get).toHaveBeenCalledWith(
                'https://api.kimi.com/coding/v1/models',
                expect.anything(),
            );
        });

        it('surfaces a 403 client-gate rejection as an auth failure', async () => {
            jest.spyOn(axios, 'post').mockRejectedValue(
                Object.assign(new Error('Request failed with status 403'), {
                    isAxiosError: true,
                    response: {
                        status: 403,
                        data: {
                            error: {
                                message:
                                    'Kimi For Coding is currently only available for Coding Agents',
                                type: 'access_terminated_error',
                            },
                        },
                    },
                }),
            );
            jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);

            const result = await buildUseCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-kimi-test',
                baseURL: 'https://api.kimi.com/coding',
                model: 'kimi-for-coding',
            });

            expect(result.ok).toBe(false);
            expect(result.code).toBe('auth');
            expect(result.providerMessage).toMatch(/Coding Agents/);
        });

        it('blocks private base URLs (SSRF guard)', async () => {
            await expect(
                buildUseCase().execute({
                    provider: 'anthropic_compatible',
                    apiKey: 'sk-kimi-test',
                    baseURL: 'https://127.0.0.1/coding',
                    model: 'kimi-for-coding',
                }),
            ).rejects.toThrow(/private or reserved address/);
        });
    });
});
