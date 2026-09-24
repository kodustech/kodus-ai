// @ts-nocheck
import { anthropicCompatibleRootURL } from '@libs/llm/model-builders';
import { BYOKProvider } from '@libs/llm/model-providers';

// Encryption is irrelevant here — deterministic reversible stand-in so
// buildModelFromSlot can decrypt the stored key without a real crypto env.
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (value: string) => `enc(${value})`,
    decrypt: (value: string) => value.replace(/^enc\(|\)$/g, ''),
}));

import { buildModelFromSlot } from '@libs/llm/byok-to-vercel';
import {
    buildReasoningProviderOptions,
    EFFORT_TO_BUDGET,
} from '@libs/llm/reasoning-options';
import { TestByokConnectionUseCase } from '@libs/organization/application/use-cases/organizationParameters/test-byok-connection.use-case';
import axios from 'axios';

// The unified probe issues its call through the AI SDK.
const generateText = jest.fn();
jest.mock('ai', () => ({
    ...jest.requireActual('ai'),
    generateText: (...args: any[]) => generateText(...args),
}));

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
            // A compatible model that thinks BY DEFAULT and CAN disable (a
            // non-always-thinking Kimi) must say "off" out loud: omitting the
            // field would leave thinking ON (the PR#144-146 Kody-Rules failure),
            // so "off" is an explicit { type: 'disabled' }, not an empty object.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC_COMPATIBLE,
                    'none',
                    'kimi-for-coding',
                ),
            ).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
        });
    });

    describe('Vercel AI SDK routing', () => {
        it('maps anthropic_compatible to an anthropic model with a /v1-suffixed base', () => {
            const model = buildModelFromSlot({
                provider: BYOKProvider.ANTHROPIC_COMPATIBLE,
                apiKey: 'enc(sk-kimi-test)',
                model: 'kimi-for-coding',
                baseURL: 'https://api.kimi.com/coding',
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

        beforeEach(() => {
            generateText.mockReset();
            generateText.mockResolvedValue({ text: 'pong' });
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('rejects anthropic_compatible without a baseURL', async () => {
            await expect(
                buildUseCase().execute({
                    provider: 'anthropic_compatible',
                    apiKey: 'sk-kimi-test',
                    model: 'kimi-for-coding',
                }),
            ).rejects.toThrow(/baseURL is required for anthropic_compatible/);
        });

        // The probe runs the model through the runtime montagem now, so the
        // endpoint and headers are the provider module's business (covered by
        // its own specs). What matters here is that the configured model is the
        // one being exercised, and that a real call happens at all.
        it('exercises the configured model when one is provided', async () => {
            const result = await buildUseCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-kimi-test',
                baseURL: 'https://api.kimi.com/coding/v1',
                model: 'kimi-for-coding',
            });

            expect(result.ok).toBe(true);
            expect(generateText).toHaveBeenCalledTimes(1);
        });

        // Without a model the probe could only prove the key, which is the
        // weaker claim the connect form used to make. It now says so instead.
        it('asks for a model instead of falling back to a weaker check', async () => {
            const result = await buildUseCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-kimi-test',
                baseURL: 'https://api.kimi.com/coding',
            });

            expect(result.ok).toBe(false);
            expect(result.code).toBe('bad_request');
            expect(result.message).toMatch(/model/i);
            expect(generateText).not.toHaveBeenCalled();
        });

        it('surfaces a 403 client-gate rejection as an auth failure', async () => {
            generateText.mockRejectedValue(
                Object.assign(new Error('Forbidden'), {
                    name: 'AI_APICallError',
                    statusCode: 403,
                    responseBody: {
                        error: {
                            message:
                                'Kimi For Coding is currently only available for Coding Agents',
                            type: 'access_terminated_error',
                        },
                    },
                }),
            );

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
