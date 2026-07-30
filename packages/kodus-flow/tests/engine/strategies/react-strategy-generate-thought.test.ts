/**
 * @file react-strategy-generate-thought.test.ts
 * @description Drives the REAL ReActStrategy.generateThought() — the exact
 * function whose catch block produced the user-facing
 * "I encountered an error while processing your request. Please try rephrasing
 * your question." fallback — with a stub LLM adapter that returns a VERBATIM
 * Claude Sonnet 4.5 response (prose preamble + fenced JSON). This proves the
 * fix end-to-end through the engine path that failed in production: the agent
 * now yields the model's real answer instead of the generic fallback.
 */

import { describe, it, expect } from 'vitest';
import { ReActStrategy } from '../../../src/engine/strategies/react-strategy.js';
import type { LLMAdapter } from '../../../src/core/types/allTypes.js';
import { SONNET_PROSE_RESPONSES } from '../../unit/sonnet-prose-responses.fixture.js';

function strategyReturning(raw: string): ReActStrategy {
    const adapter = {
        call: async () => ({ content: raw }),
    } as unknown as LLMAdapter;
    return new ReActStrategy(adapter);
}

function makeContext(): any {
    return {
        input: '@kody esse cron desativa licenças todo dia? resume rapidinho.',
        mode: 'executor',
        history: [],
        scratchpad: undefined,
        config: { scratchpad: { enabled: false } },
        currentIteration: 0,
        maxIterations: 10,
        agentContext: {
            thread: { id: 'test-thread' },
            correlationId: 'corr_test',
            tenantId: 'kodus-agent-conversation',
            sessionId: 'sess_test',
            agentName: 'conversation-agent',
        },
    };
}

const FALLBACK = 'encountered an error while processing your request';

describe('ReActStrategy.generateThought — real Sonnet response through the engine', () => {
    it.each(SONNET_PROSE_RESPONSES.map((r, i) => [i, r] as const))(
        'fixture #%i: yields the real final answer, not the error fallback',
        async (_i, raw) => {
            const strategy = strategyReturning(raw);
            const thought = await (strategy as any).generateThought(
                makeContext(),
                0,
                [],
            );

            // not the generic fallback
            expect(thought.metadata?.fallbackUsed).not.toBe(true);
            expect(thought.action.content.toLowerCase()).not.toContain(FALLBACK);

            // the model's real answer comes through
            expect(thought.action.type).toBe('final_answer');
            expect(thought.action.content.toLowerCase()).toContain('cron');
            expect(thought.reasoning.length).toBeGreaterThan(0);
        },
    );

    it('sanity: a malformed (non-JSON) response DOES still fall back', async () => {
        const strategy = strategyReturning('this is not json at all, sorry');
        const thought = await (strategy as any).generateThought(
            makeContext(),
            0,
            [],
        );
        expect(thought.metadata?.fallbackUsed).toBe(true);
    });
});
