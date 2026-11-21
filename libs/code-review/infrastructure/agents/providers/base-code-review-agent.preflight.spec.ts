import { assertContextWindowFitsOverhead } from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';
import { AgentContextWindowTooSmallError } from '@libs/llm/errors';
import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';

describe('assertContextWindowFitsOverhead', () => {
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

    describe('the overhead must leave room in the prompt budget', () => {
        it('throws at 16K: the compact overhead fills the 55% budget', () => {
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
            ).toThrow(AgentContextWindowTooSmallError);
        });

        it('throws at 12K even though the overhead fits the window', () => {
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
            ).toThrow(AgentContextWindowTooSmallError);
        });

        it('leaves out a callGraph the profile drops', () => {
            const light = resolveAdaptiveProfile(32_768);
            const check = (adaptiveProfile: any) => () =>
                assertContextWindowFitsOverhead({
                    input: {
                        changedFiles: [],
                        callGraph: 'edge: a→b\n'.repeat(2_000), // ~20K chars
                        adaptiveProfile,
                    },
                    contextWindow: 32_768,
                    modelName: 'llama-32k',
                });
            expect(check({ ...light, dropCallGraph: false })).toThrow(
                AgentContextWindowTooSmallError,
            );
            expect(check(light)).not.toThrow();
        });

        it('a full-size window still allows overhead past the budget', () => {
            expect(() =>
                assertContextWindowFitsOverhead({
                    input: {
                        changedFiles: [],
                        callGraph: 'x'.repeat(400_000),
                        adaptiveProfile: resolveAdaptiveProfile(200_000),
                    },
                    contextWindow: 200_000,
                    modelName: 'big',
                }),
            ).not.toThrow();
        });
    });
});
