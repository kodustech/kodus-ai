import type { NormalizedModel } from '@libs/llm/byok-config';

import { structuredCallAnswerTokens } from './structured-review-call';

/**
 * The answer a structured call (PR summary, implementation check) declares,
 * for the window to hold: what the adapter is really sent, with this
 * executor's reasoning, on the slot or its fallback.
 */

const slot = (fields: Record<string, unknown>) =>
    ({ apiKey: 'k', ...fields }) as unknown as NormalizedModel;

describe('structuredCallAnswerTokens', () => {
    it('counts no thinking budget a structured call does not send', async () => {
        await expect(
            structuredCallAnswerTokens(
                slot({
                    provider: 'anthropic',
                    model: 'claude-haiku-4-5-20251001',
                    maxOutputTokens: 8_192,
                }),
            ),
        ).resolves.toBe(8_192);
        await expect(
            structuredCallAnswerTokens(
                slot({
                    provider: 'amazon_bedrock',
                    model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
                    maxOutputTokens: 64_000,
                    reasoningEffort: 'high',
                }),
            ),
        ).resolves.toBe(64_000);
    });

    it("keeps the model's whole output limit when the slot sets none: the adapter declares it", async () => {
        await expect(
            structuredCallAnswerTokens(
                slot({
                    provider: 'anthropic',
                    model: 'claude-haiku-4-5-20251001',
                }),
            ),
        ).resolves.toBe(64_000);
    });

    it('declares nothing for a provider that sends no limit of its own', async () => {
        await expect(
            structuredCallAnswerTokens(
                slot({ provider: 'openai', model: 'gpt-4o' }),
            ),
        ).resolves.toBeUndefined();
    });

    it("takes the fallback's answer when it is the larger one", async () => {
        await expect(
            structuredCallAnswerTokens(
                slot({
                    provider: 'openai',
                    model: 'gpt-4o',
                    maxOutputTokens: 1_000,
                    fallback: {
                        provider: 'anthropic',
                        apiKey: 'k',
                        model: 'claude-haiku-4-5-20251001',
                        maxOutputTokens: 8_192,
                    },
                }),
            ),
        ).resolves.toBe(8_192);
    });
});
