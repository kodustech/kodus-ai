import type { NormalizedModel } from '@libs/llm/byok-config';

import { judgeWindow, reservedOutputTokens } from './model-window';

/**
 * What a judge call declares as its answer, and the window it must fit: the
 * request the provider receives, not the one the caller asked for.
 */

const slot = (fields: Record<string, unknown>) =>
    ({ apiKey: '', ...fields }) as unknown as NormalizedModel;

describe('reservedOutputTokens', () => {
    it("reserves the only slot's own answer limit, even below what the caller asks", () => {
        expect(
            reservedOutputTokens(
                slot({
                    provider: 'openai_compatible',
                    model: 'local-open-weights',
                    maxInputTokens: 16_000,
                    maxOutputTokens: 1_000,
                }),
                4_000,
            ),
        ).toBe(1_000);
    });

    it('reserves the thinking budget Anthropic sends on top of the answer', () => {
        expect(
            reservedOutputTokens(
                slot({
                    provider: 'anthropic',
                    model: 'claude-sonnet-4-5',
                    reasoningEffort: 'high',
                }),
                20_000,
            ),
        ).toBe(60_000);
    });

    it('reserves the thinking budget an Anthropic-compatible model gets by default', () => {
        expect(
            reservedOutputTokens(
                slot({ provider: 'anthropic_compatible', model: 'glm-4.6' }),
                8_000,
            ),
        ).toBeGreaterThan(8_000);
    });

    it('adds nothing for a provider that keeps reasoning inside the answer', () => {
        expect(
            reservedOutputTokens(
                slot({ provider: 'openai', model: 'gpt-5' }),
                20_000,
            ),
        ).toBe(20_000);
    });
});

describe('judgeWindow', () => {
    const saved = {
        provider: process.env.API_LLM_PROVIDER,
        model: process.env.API_LLM_PROVIDER_MODEL,
    };
    afterEach(() => {
        for (const [key, value] of [
            ['API_LLM_PROVIDER', saved.provider],
            ['API_LLM_PROVIDER_MODEL', saved.model],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('sizes the call by the env model when there is no slot', () => {
        process.env.API_LLM_PROVIDER = 'openai';
        process.env.API_LLM_PROVIDER_MODEL = 'gpt-4';
        expect(judgeWindow(undefined)).toBe(8_192);
    });
});
