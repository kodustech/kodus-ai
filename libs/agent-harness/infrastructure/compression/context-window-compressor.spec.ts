/**
 * ContextWindowCompressor unit tests — the budget/clamp seam (issue #1574).
 *
 * The regression that mattered: an oversized window used to be returned
 * unchanged (maybeCompress → null) once soft truncation couldn't save tokens,
 * so the provider received a request larger than its context window and 400-ed
 * the whole review. These tests pin the new invariant: the compressor NEVER
 * hands back a window that still exceeds the real budget.
 */
import type { AgentMessage } from '@libs/agent-harness/domain/contracts/run-state.contract';

import { ContextWindowCompressor } from './context-window-compressor';
import { estimateMessagesTokens } from './context-compressor';

function toModel(messages: AgentMessage[]) {
    return messages.map((m) => ({ role: m.role, content: m.content }) as any);
}

/** A tool-loop window that has already blown well past the given window size. */
function overflowingWindow(rounds: number, resultChars: number): AgentMessage[] {
    const msgs: AgentMessage[] = [
        { role: 'user', content: 'Review this diff:\n' + 'x'.repeat(2_000) },
    ];
    for (let i = 0; i < rounds; i++) {
        msgs.push({
            role: 'assistant',
            content: [
                { type: 'text', text: `investigating ${i}` },
                {
                    type: 'tool-call',
                    toolCallId: `c${i}`,
                    toolName: 'readFile',
                    input: { path: `f${i}.ts` },
                },
            ] as any,
        });
        msgs.push({
            role: 'tool',
            content: [
                {
                    type: 'tool-result',
                    toolCallId: `c${i}`,
                    toolName: 'readFile',
                    output: 'y'.repeat(resultChars),
                },
            ] as any,
        });
    }
    return msgs;
}

describe('ContextWindowCompressor', () => {
    it('returns null when the window is comfortably under budget', () => {
        const c = new ContextWindowCompressor(200_000);
        const small: AgentMessage[] = [
            { role: 'user', content: 'tiny prompt' },
            { role: 'assistant', content: 'ok' },
        ];
        expect(c.maybeCompress(small)).toBeNull();
    });

    it('returns null for a non-positive window', () => {
        expect(new ContextWindowCompressor(0).maybeCompress([])).toBeNull();
    });

    it('clamps an overflowing window to fit window − overhead − margin', () => {
        const contextWindow = 40_000;
        const overheadTokens = 12_000; // system + tool schemas
        const c = new ContextWindowCompressor(contextWindow, {
            overheadTokens,
            safetyMarginTokens: 2_000,
        });
        const msgs = overflowingWindow(40, 8_000);

        const result = c.maybeCompress(msgs);
        expect(result).not.toBeNull();

        const budget = contextWindow - overheadTokens - 2_000; // 26_000
        // The clamped messages must fit the real budget...
        expect(result!.afterTokens).toBeLessThanOrEqual(budget);
        // ...and the total request (messages + overhead) must fit the window.
        expect(result!.afterTokens + overheadTokens).toBeLessThanOrEqual(
            contextWindow,
        );
        // Sanity: it actually reduced the window.
        expect(result!.afterTokens).toBeLessThan(result!.beforeTokens);
    });

    it('never returns a window that still overflows, even when soft truncation cannot save enough', () => {
        // Overhead alone eats most of the window → the messages budget is tiny,
        // so the soft pass can't get under it and the hard clamp MUST engage.
        const contextWindow = 20_000;
        const c = new ContextWindowCompressor(contextWindow, {
            overheadTokens: 10_000,
            safetyMarginTokens: 1_000,
        });
        const msgs = overflowingWindow(25, 6_000);

        const result = c.maybeCompress(msgs);
        // The old code returned null here (no savings) and shipped the overflow.
        expect(result).not.toBeNull();

        const budget = 20_000 - 10_000 - 1_000; // 9_000
        expect(
            estimateMessagesTokens(toModel(result!.messages as AgentMessage[])),
        ).toBeLessThanOrEqual(budget);
    });

    it('preserves tool content as an array so the AI SDK does not crash on content.filter', () => {
        const c = new ContextWindowCompressor(40_000, {
            overheadTokens: 12_000,
        });
        const result = c.maybeCompress(overflowingWindow(40, 8_000));
        const toolMsg = (result!.messages as AgentMessage[]).find(
            (m) => m.role === 'tool',
        );
        expect(Array.isArray(toolMsg?.content)).toBe(true);
    });
});
