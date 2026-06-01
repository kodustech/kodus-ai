import { assertContextWindowFitsOverhead } from './base-code-review-agent.provider';
import { AgentContextWindowTooSmallError } from './llm/errors';
import { resolveAdaptiveProfile } from './llm/adaptive-fit';

describe('assertContextWindowFitsOverhead', () => {
    it('does not throw when contextWindow comfortably exceeds the static overhead', () => {
        expect(() =>
            assertContextWindowFitsOverhead({
                input: {
                    changedFiles: [],
                    prTitle: 'Add feature',
                    prBody: 'small body',
                },
                contextWindow: 128_000,
                modelName: 'gemini-2.5-pro',
            }),
        ).not.toThrow();
    });

    it('throws AgentContextWindowTooSmallError when overhead alone exceeds the window (Llama 12,288)', () => {
        // The agent's static prompt overhead is ~15_500 tokens (system prompt
        // + tool schemas). A 12_288-token Llama cannot fit even an empty PR.
        expect(() =>
            assertContextWindowFitsOverhead({
                input: {
                    changedFiles: [
                        { filename: 'a.ts', patch: 'diff --git a/a.ts b/a.ts' },
                    ] as any,
                    prTitle: 'tiny',
                    prBody: 'tiny',
                },
                contextWindow: 12_288,
                modelName: 'meta-llama/Llama-3.3-70B-Instruct',
            }),
        ).toThrow(AgentContextWindowTooSmallError);
    });

    it('error carries the numeric context for telemetry/UI', () => {
        try {
            assertContextWindowFitsOverhead({
                input: {
                    changedFiles: [],
                    prTitle: '',
                    prBody: '',
                },
                contextWindow: 12_288,
                modelName: 'llama',
            });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(AgentContextWindowTooSmallError);
            const err = e as AgentContextWindowTooSmallError;
            expect(err.contextWindow).toBe(12_288);
            expect(err.overheadTokens).toBeGreaterThan(12_288);
            expect(err.modelName).toBe('llama');
        }
    });

    it('does NOT throw at 32_768 (Llama 32K still fits the overhead with margin)', () => {
        expect(() =>
            assertContextWindowFitsOverhead({
                input: {
                    changedFiles: [],
                    prTitle: '',
                    prBody: '',
                },
                contextWindow: 32_768,
                modelName: 'llama-32k',
            }),
        ).not.toThrow();
    });

    describe('adaptive-fit profile is honored', () => {
        it('compact profile reduces estimated overhead → 16K window passes preflight', () => {
            // Without the profile, 16K throws because the 15.5K-token
            // static overhead leaves ~0 headroom — exactly the bug the
            // first post-fix benchmark surfaced. With the compact
            // profile in input, overhead drops to ~12K, leaving ~4K
            // headroom for diffs.
            expect(() =>
                assertContextWindowFitsOverhead({
                    input: {
                        changedFiles: [
                            { filename: 'a.ts', patch: 'small' } as any,
                        ],
                        prTitle: 'tiny',
                        prBody: 'tiny',
                        adaptiveProfile: resolveAdaptiveProfile(16_000),
                    },
                    contextWindow: 16_000,
                    modelName: 'llama-16k',
                }),
            ).not.toThrow();
        });

        it('compact profile reduces 12K overhead to JUST under the window — preflight passes, the prompt-size preflight downstream is the real gate', () => {
            // After the compact path drops 14K chars from the static
            // overhead, a 12K window has ~288 tokens of headroom over
            // the overhead estimate. The overhead preflight (this one)
            // passes. The downstream prompt-size preflight in
            // assertPromptFitsInContext then evaluates against the
            // actual systemPrompt + userPrompt and decides whether
            // there's room for the diffs + output reserve.
            //
            // This locks in the structural change: 12K is no longer
            // blocked by the OVERHEAD preflight. Whether 12K is
            // end-to-end viable is a benchmark question, not a unit
            // test question — the benchmark sweep is the source of
            // truth.
            expect(() =>
                assertContextWindowFitsOverhead({
                    input: {
                        changedFiles: [
                            { filename: 'a.ts', patch: 'small' } as any,
                        ],
                        adaptiveProfile: resolveAdaptiveProfile(12_288),
                    },
                    contextWindow: 12_288,
                    modelName: 'llama-12k',
                }),
            ).not.toThrow();
        });

        it('callGraph is excluded from estimate when dropCallGraph is set', () => {
            // A big callGraph (10K chars) would normally push overhead
            // over a 16K window. Profile drops it → overhead unchanged
            // and the preflight passes.
            const bigCallGraph = 'edge: a→b\n'.repeat(1_000); // ~10K chars
            expect(() =>
                assertContextWindowFitsOverhead({
                    input: {
                        changedFiles: [],
                        callGraph: bigCallGraph,
                        adaptiveProfile: resolveAdaptiveProfile(16_000),
                    },
                    contextWindow: 16_000,
                    modelName: 'llama-16k',
                }),
            ).not.toThrow();
        });
    });
});
