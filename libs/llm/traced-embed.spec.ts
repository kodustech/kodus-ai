/**
 * Embeddings need the same wall-clock floor model calls have.
 *
 * Both production callers are fail-soft against ERRORS — the dedup guard
 * catches and falls back to a lexical veto, `document.ts` has no catch at all
 * — and neither is protected against SILENCE. A request that never answers
 * throws nothing, so the catch never runs and the stage waits forever, which
 * is precisely how the agent loop hung on 2026-09-03.
 *
 * `hardTimeout` grants ms + 5s of grace so a provider that DOES honour the
 * abort settles on its own first; the test advances fake timers past it.
 */
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, embed: jest.fn() };
});

import { embed } from 'ai';
import { tracedEmbed } from '@libs/llm/llm-call';

const mockEmbed = embed as unknown as jest.Mock;

describe('tracedEmbed — a stalled embedding endpoint must not hang the stage', () => {
    beforeEach(() => jest.clearAllMocks());
    afterEach(() => jest.useRealTimers());

    it('rejects on the wall clock when the endpoint never answers', async () => {
        jest.useFakeTimers();
        mockEmbed.mockImplementation(() => new Promise(() => {}));

        const settled = expect(
            tracedEmbed({
                model: {} as any,
                value: 'x',
                __kodusHardTimeoutMs: 40,
            } as any),
        ).rejects.toThrow(/\[HARD-TIMEOUT\]/);
        await jest.advanceTimersByTimeAsync(40 + 5_000);
        await settled;
    });

    it('returns the embedding untouched when the endpoint answers', async () => {
        const result = { embedding: [0.1, 0.2], usage: { tokens: 3 } };
        mockEmbed.mockResolvedValue(result);

        await expect(
            tracedEmbed({ model: {} as any, value: 'x' } as any),
        ).resolves.toBe(result);
    });
});
