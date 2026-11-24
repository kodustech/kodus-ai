import type { NormalizedModel } from '@libs/llm/byok-config';
import { resolveContextWindow } from '@libs/llm/model-context-window';

import {
    knownSlotContextWindow,
    slotContextWindow,
    slotInputRoom,
} from './slot-window';

/**
 * The window a call on a slot must fit: `LLM.run` sends the same request to
 * the fallback, so the smaller of the two counts.
 */

const slot = (fields: Record<string, unknown>) =>
    ({
        apiKey: '',
        provider: 'openai_compatible',
        ...fields,
    }) as unknown as NormalizedModel;

const DEFAULT_WINDOW = resolveContextWindow({ modelName: 'no-such-model-x' });

describe('knownSlotContextWindow', () => {
    it("caps a known primary at the default guess when the fallback's window is unknown", () => {
        const big = slot({
            model: 'big',
            maxInputTokens: 1_000_000,
            fallback: {
                provider: 'openai_compatible',
                apiKey: '',
                model: 'no-such-model-x',
            },
        });
        expect(knownSlotContextWindow(big)).toBe(DEFAULT_WINDOW);
        expect(DEFAULT_WINDOW).toBeLessThan(1_000_000);
    });

    it('takes the smaller of two known windows, and nothing when neither is known', () => {
        expect(
            knownSlotContextWindow(
                slot({
                    model: 'a',
                    maxInputTokens: 200_000,
                    fallback: {
                        provider: 'openai_compatible',
                        apiKey: '',
                        model: 'b',
                        maxInputTokens: 32_000,
                    },
                }),
            ),
        ).toBe(32_000);
        expect(
            knownSlotContextWindow(slot({ model: 'no-such-model-x' })),
        ).toBeUndefined();
    });

    it("takes a known fallback's window when only the primary's is a guess", () => {
        expect(
            knownSlotContextWindow(
                slot({
                    model: 'no-such-model-x',
                    fallback: {
                        provider: 'openai_compatible',
                        apiKey: '',
                        model: 'b',
                        maxInputTokens: 32_000,
                    },
                }),
            ),
        ).toBe(32_000);
    });

    it('agrees with slotContextWindow wherever the window is known', () => {
        const s = slot({ model: 'a', maxInputTokens: 50_000 });
        expect(knownSlotContextWindow(s)).toBe(slotContextWindow(s));
    });
});

describe('slotInputRoom', () => {
    it('takes the tightest attempt, never the smallest window beside the largest answer', async () => {
        const s = slot({
            model: 'big',
            maxInputTokens: 200_000,
            maxOutputTokens: 64_000,
            fallback: {
                provider: 'openai_compatible',
                apiKey: '',
                model: 'small',
                maxInputTokens: 32_000,
                maxOutputTokens: 1_000,
            },
        });
        const room = await slotInputRoom(
            s,
            async (model) => model?.maxOutputTokens ?? 0,
        );
        // 200k - 64k for the slot, 32k - 1k for the fallback.
        expect(room).toBe(31_000);
    });
});
