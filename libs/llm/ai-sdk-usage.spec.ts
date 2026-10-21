import { readAiSdkUsage, readAiSdkUsageFromError } from './ai-sdk-usage';

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

    it('captures Gemini implicit-cache read from inputTokenDetails.cacheReadTokens (#1799)', () => {
        // Shape ai@7 produces from @ai-sdk/google's convertGoogleUsage:
        //   inputTokens (total, INCLUDING cached) = promptTokenCount
        //   inputTokenDetails.cacheReadTokens      = cachedContentTokenCount
        //   outputTokenDetails.reasoningTokens     = thoughtsTokenCount
        //   (no cacheWrite — Gemini reports no cache CREATION count)
        // Older @ai-sdk/google (≈4.0.8) did NOT surface cachedContentTokenCount
        // into this normalized field, so Kody recorded cache-read = 0 even when
        // Gemini's implicit cache hit — the root cause of #1799. Current adapters
        // (4.0.49) map it to `inputTokens.cacheRead`; this pins that the reader
        // captures it, so a future adapter regression can't silently zero it again.
        const usage = {
            inputTokens: 68660, // total, includes the 32,740 cached
            outputTokens: 1200,
            totalTokens: 69860,
            inputTokenDetails: {
                noCacheTokens: 35920,
                cacheReadTokens: 32740,
            },
            outputTokenDetails: { textTokens: 200, reasoningTokens: 1000 },
        };

        const r = readAiSdkUsage(usage);
        expect(r.cacheReadTokens).toBe(32740);
        expect(r.cacheWriteTokens).toBeUndefined();
        expect(r.reasoningTokens).toBe(1000);
        // The full input count is preserved un-reduced (the cost calculator
        // subtracts cacheRead from the full-price pool downstream).
        expect(r.inputTokens).toBe(68660);
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

/**
 * A structured call that dies in the output parse (AI_NoObjectGeneratedError)
 * was answered — and billed — by the provider. Before this reader the wrapper
 * span recorded the error and zero tokens, so the spend showed up in Langfuse
 * and never in `observability_telemetry` (the `structuredRecovery` leak).
 */
describe('readAiSdkUsageFromError', () => {
    const noObjectGenerated = (usage: unknown) =>
        Object.assign(
            new Error('No object generated: response did not match schema.'),
            {
                name: 'AI_NoObjectGeneratedError',
                finishReason: 'stop',
                usage,
            },
        );

    it('recovers the billed usage from a NoObjectGeneratedError', () => {
        const got = readAiSdkUsageFromError(
            noObjectGenerated({
                inputTokens: 766,
                outputTokens: 2503,
                totalTokens: 3269,
                outputTokenDetails: { reasoningTokens: 2100 },
            }),
        );

        expect(got?.finishReason).toBe('stop');
        expect(got?.usage).toMatchObject({
            inputTokens: 766,
            outputTokens: 2503,
            totalTokens: 3269,
            reasoningTokens: 2100,
        });
    });

    it('unwraps usage carried on the error cause', () => {
        const err = Object.assign(new Error('wrapped'), {
            cause: noObjectGenerated({
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
            }),
        });

        expect(readAiSdkUsageFromError(err)?.usage.totalTokens).toBe(15);
    });

    it('returns undefined when nothing was billed', () => {
        // Transport failures (timeout, 429, reset): no response, no usage — must
        // not write a zero-token cost span.
        expect(
            readAiSdkUsageFromError(new Error('fetch failed')),
        ).toBeUndefined();
        expect(
            readAiSdkUsageFromError(
                noObjectGenerated({
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                }),
            ),
        ).toBeUndefined();
        expect(readAiSdkUsageFromError(undefined)).toBeUndefined();
        expect(readAiSdkUsageFromError(null)).toBeUndefined();
    });
});
