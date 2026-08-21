import { readAiSdkUsage } from './ai-sdk-agent-runner';

/**
 * Regression test for "fix(observability): read ai@7 cache/reasoning
 * usage fields" (PR #1616, 2026-07-22): the Vercel AI SDK v7 moved cache
 * and reasoning token counts from top-level `usage.cachedInputTokens` /
 * `usage.reasoningTokens` into `usage.inputTokenDetails.cacheReadTokens` /
 * `usage.outputTokenDetails.reasoningTokens`. The harness kept reading the
 * removed top-level fields, so every agent span silently recorded
 * cacheRead=0 after selfhosted-2.1.26 — cache hits were billed as full
 * input tokens, a silent billing-correctness bug with no error anywhere.
 *
 * readAiSdkUsage is the single place this mapping happens for the agent
 * harness (ai-sdk-agent-runner.ts); an equivalent, NOT-shared inline
 * expression also lives in observability.service.ts's runAiSdkLLMInSpan
 * (a separate, currently untested copy of the same logic — worth
 * de-duplicating onto this function, but out of scope here).
 */
describe('readAiSdkUsage', () => {
    it('prefers ai@7 nested inputTokenDetails/outputTokenDetails when present', () => {
        const usage = {
            inputTokens: 100,
            outputTokens: 50,
            // ai@7 shape
            inputTokenDetails: { cacheReadTokens: 80 },
            outputTokenDetails: { reasoningTokens: 20 },
            // stale/absent in v7, must NOT win over the nested fields
            cachedInputTokens: 0,
            reasoningTokens: 0,
        };

        expect(readAiSdkUsage(usage)).toEqual({
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 80,
            reasoningTokens: 20,
        });
    });

    it('falls back to ai@6 top-level fields when v7 nested details are absent', () => {
        const usage = {
            inputTokens: 100,
            outputTokens: 50,
            cachedInputTokens: 80,
            reasoningTokens: 20,
        };

        expect(readAiSdkUsage(usage)).toEqual({
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 80,
            reasoningTokens: 20,
        });
    });

    it('does NOT silently read 0 when v7 details exist but the value itself is legitimately 0', () => {
        // A real cache miss (0 tokens cached) must stay 0, not fall through
        // to a stale/undefined v6 field and produce `undefined` instead.
        const usage = {
            inputTokens: 100,
            outputTokens: 50,
            inputTokenDetails: { cacheReadTokens: 0 },
            outputTokenDetails: { reasoningTokens: 0 },
        };

        expect(readAiSdkUsage(usage)).toEqual({
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            reasoningTokens: 0,
        });
    });

    it('this is the exact incident: v7 usage with only top-level fields present (the removed ai@6 shape) reads as undefined, not silently 0-from-elsewhere', () => {
        // The bug was never "throws" or "crashes" — it's usage.cachedInputTokens
        // no longer existing on ai@7 responses at all, so the OLD code
        // (reading only the top-level field) got `undefined`, which
        // downstream billing/observability code coerced to 0. Confirm the
        // FIXED reader gets the real value from the nested field instead.
        const v7ResponseNoTopLevelFields = {
            inputTokens: 1000,
            outputTokens: 200,
            inputTokenDetails: { cacheReadTokens: 950 },
            outputTokenDetails: { reasoningTokens: 40 },
            // cachedInputTokens / reasoningTokens simply don't exist on a
            // real ai@7 response — not present at all, not just falsy.
        };

        const result = readAiSdkUsage(v7ResponseNoTopLevelFields);
        expect(result.cacheReadTokens).toBe(950);
        expect(result.reasoningTokens).toBe(40);
    });

    it('returns undefined fields (not throws) for a bare/empty usage object', () => {
        expect(readAiSdkUsage({})).toEqual({
            inputTokens: undefined,
            outputTokens: undefined,
            cacheReadTokens: undefined,
            reasoningTokens: undefined,
        });
    });

    it('returns undefined fields (not throws) for undefined usage', () => {
        expect(readAiSdkUsage(undefined)).toEqual({
            inputTokens: undefined,
            outputTokens: undefined,
            cacheReadTokens: undefined,
            reasoningTokens: undefined,
        });
    });
});
