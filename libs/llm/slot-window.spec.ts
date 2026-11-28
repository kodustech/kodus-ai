import type { NormalizedModel } from '@libs/llm/byok-config';
import { resolveContextWindow } from '@libs/llm/model-context-window';

import { cappedByFallback, slotInputRoom } from './slot-window';

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

describe('cappedByFallback', () => {
    const fallback = (fields: Record<string, unknown>) => ({
        provider: 'openai_compatible',
        apiKey: '',
        ...fields,
    });

    // QA of #2681: a 1M primary with a 24k GLM fallback planned the review
    // at 1,000,000.
    it("caps the primary's window at a smaller fallback's", () => {
        const s = slot({
            model: 'big',
            maxInputTokens: 1_000_000,
            fallback: fallback({ model: 'glm', maxInputTokens: 24_000 }),
        });
        expect(cappedByFallback(1_000_000, s)).toBe(24_000);
    });

    it("caps a known primary at the default window when the fallback's is unknown", () => {
        const s = slot({
            model: 'big',
            fallback: fallback({ model: 'no-such-model-x' }),
        });
        expect(cappedByFallback(1_000_000, s)).toBe(DEFAULT_WINDOW);
        expect(DEFAULT_WINDOW).toBeLessThan(1_000_000);
    });

    it('keeps the primary window without a fallback, or beside a larger one', () => {
        expect(cappedByFallback(50_000, slot({ model: 'a' }))).toBe(50_000);
        expect(cappedByFallback(50_000, undefined)).toBe(50_000);
        expect(
            cappedByFallback(
                50_000,
                slot({
                    model: 'a',
                    fallback: fallback({ model: 'b', maxInputTokens: 200_000 }),
                }),
            ),
        ).toBe(50_000);
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
