import { readAiSdkUsage } from './ai-sdk-usage';

/**
 * The single AI SDK usage reader (shared by the agent harness and
 * observability.service). Combines:
 *  - PR #1616 (2026-07-22): ai@7 moved cache-read + reasoning from top-level
 *    `cachedInputTokens` / `reasoningTokens` into
 *    `inputTokenDetails.cacheReadTokens` / `outputTokenDetails.reasoningTokens`.
 *    Reading the removed top-level fields silently recorded cacheRead=0.
 *  - the cache-WRITE follow-up: `inputTokenDetails.cacheWriteTokens` (cache
 *    creation, billed at a premium by anthropic/bedrock) was never read by
 *    EITHER copy, so `cache_creation` recorded 0 and was folded into plain input.
 */
describe('readAiSdkUsage', () => {
    it('prefers ai@7 nested inputTokenDetails/outputTokenDetails when present', () => {
        const usage = {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 10 },
            outputTokenDetails: { reasoningTokens: 20 },
            // stale/absent in v7, must NOT win over the nested fields
            cachedInputTokens: 0,
            reasoningTokens: 0,
        };

        expect(readAiSdkUsage(usage)).toEqual({
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
            reasoningTokens: 20,
        });
    });

    it('falls back to ai@6 top-level fields when v7 nested details are absent', () => {
        const usage = {
            inputTokens: 100,
            outputTokens: 50,
            cachedInputTokens: 80,
            reasoningTokens: 20,
            cacheCreationInputTokens: 10,
        };

        expect(readAiSdkUsage(usage)).toMatchObject({
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
            reasoningTokens: 20,
        });
    });

    it('does NOT silently read 0 when v7 details exist but the value is legitimately 0', () => {
        // A real cache miss (0 cached) must stay 0, not fall through to a stale
        // v6 field and become `undefined`.
        const usage = {
            inputTokens: 100,
            outputTokens: 50,
            inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { reasoningTokens: 0 },
        };

        const r = readAiSdkUsage(usage);
        expect(r.cacheReadTokens).toBe(0);
        expect(r.cacheWriteTokens).toBe(0);
        expect(r.reasoningTokens).toBe(0);
    });

    it('reads anthropic cache CREATION from inputTokenDetails.cacheWriteTokens', () => {
        // input (total) = noCache 120 + cacheRead 800 + cacheWrite 80 = 1000
        const usage = {
            inputTokens: 1000,
            outputTokens: 50,
            inputTokenDetails: {
                noCacheTokens: 120,
                cacheReadTokens: 800,
                cacheWriteTokens: 80,
            },
        };

        expect(readAiSdkUsage(usage)).toMatchObject({
            inputTokens: 1000,
            cacheReadTokens: 800,
            cacheWriteTokens: 80,
        });
    });

    it('leaves cacheWriteTokens undefined for providers that do not report it (openai/gemini/openai-compatible)', () => {
        const usage = {
            inputTokens: 900,
            outputTokens: 50,
            inputTokenDetails: { cacheReadTokens: 800 }, // no cacheWriteTokens
        };

        expect(readAiSdkUsage(usage).cacheWriteTokens).toBeUndefined();
    });

    it('returns undefined fields (not throws) for a bare/empty usage object', () => {
        expect(readAiSdkUsage({})).toEqual({
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
            reasoningTokens: undefined,
        });
    });

    it('returns undefined fields (not throws) for null/undefined usage', () => {
        expect(readAiSdkUsage(undefined)).toEqual({
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
            reasoningTokens: undefined,
        });
        expect(readAiSdkUsage(null)).toEqual(readAiSdkUsage(undefined));
    });
});
