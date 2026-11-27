import { assertContextWindowFitsOverhead } from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';
import { AgentContextWindowTooSmallError } from '@libs/llm/errors';
import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';

describe('assertContextWindowFitsOverhead', () => {
    const check = (overheadTokens: number, contextWindow: number) => () =>
        assertContextWindowFitsOverhead({
            overheadTokens,
            adaptiveProfile: resolveAdaptiveProfile(contextWindow),
            contextWindow,
            modelName: 'llama',
        });

    it('error carries the measured overhead for telemetry/UI', () => {
        try {
            check(7_000, 12_288)();
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(AgentContextWindowTooSmallError);
            const err = e as AgentContextWindowTooSmallError;
            expect(err.contextWindow).toBe(12_288);
            expect(err.overheadTokens).toBe(7_000);
            expect(err.modelName).toBe('llama');
        }
    });

    describe('on a small window the overhead must leave room in the prompt budget', () => {
        it('throws once the overhead reaches 55% of the window', () => {
            expect(check(6_758, 12_288)).toThrow(
                AgentContextWindowTooSmallError,
            );
            expect(check(6_757, 12_288)).not.toThrow();
        });

        it('runs a small PR whose real fixed prompt fits (#2205 QA)', () => {
            // ~2K tokens: the compact prompt and tool schemas of a 1-file PR.
            for (const window of [8_000, 12_288, 16_000, 20_000]) {
                expect(check(2_000, window)).not.toThrow();
            }
        });
    });

    it('a full-size window still allows overhead past the budget', () => {
        expect(check(150_000, 200_000)).not.toThrow();
        expect(check(200_000, 200_000)).toThrow(
            AgentContextWindowTooSmallError,
        );
    });
});
