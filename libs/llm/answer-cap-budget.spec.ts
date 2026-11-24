/**
 * What the Anthropic adapter declares as `max_tokens`, asked of the adapter
 * itself. The adapter is the real one; only its first build fails here, the
 * way a load error or a thrown option check would.
 */
const failNext = { build: false };
jest.mock('@ai-sdk/anthropic', () => {
    const actual = jest.requireActual('@ai-sdk/anthropic');
    return {
        ...actual,
        createAnthropic: (options: unknown) => {
            if (failNext.build) {
                failNext.build = false;
                throw new Error('adapter failed to build');
            }
            return actual.createAnthropic(options);
        },
    };
});

import { anthropicDeclaredMaxTokens } from './answer-cap-budget';

const thinking = {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 40_000 } },
};

describe('anthropicDeclaredMaxTokens', () => {
    it("caps answer and budget at a Claude model's output limit, as the adapter sends them", async () => {
        await expect(
            anthropicDeclaredMaxTokens(
                'claude-haiku-4-5-20251001',
                64_000,
                thinking,
            ),
        ).resolves.toBe(64_000);
        await expect(
            anthropicDeclaredMaxTokens('glm-4.6', 20_000, thinking),
        ).resolves.toBe(60_000);
    });

    it('asks the adapter again after a probe that could not tell', async () => {
        failNext.build = true;
        await expect(
            anthropicDeclaredMaxTokens('claude-sonnet-4-5', 20_000, thinking),
        ).resolves.toBeUndefined();
        await expect(
            anthropicDeclaredMaxTokens('claude-sonnet-4-5', 20_000, thinking),
        ).resolves.toBe(60_000);
    });
});
