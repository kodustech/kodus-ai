/**
 * context-compressor unit tests — hard per-request clamp (issue #1574).
 *
 * The clamp must GUARANTEE the returned window fits a real token budget while
 * keeping the message structure valid for the AI SDK (no orphaned tool result:
 * every `tool` message stays paired with the assistant turn it answers).
 */
import {
    clampMessagesToBudget,
    compressMessages,
    estimateMessagesTokens,
    type ModelMessage,
} from './context-compressor';

/** Build a realistic tool-loop window: head user (diff) + N assistant/tool rounds. */
function buildWindow(rounds: number, resultChars: number): ModelMessage[] {
    const msgs: ModelMessage[] = [
        { role: 'user', content: 'Review this diff:\n' + 'x'.repeat(2_000) },
    ];
    for (let i = 0; i < rounds; i++) {
        msgs.push({
            role: 'assistant',
            content: [
                { type: 'text', text: `step ${i}` },
                {
                    type: 'tool-call',
                    toolCallId: `c${i}`,
                    toolName: 'readFile',
                    input: { path: `file${i}.ts` },
                },
            ],
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
            ],
        });
    }
    return msgs;
}

/** A `tool` message is orphaned if no preceding assistant carries its callId. */
function hasOrphanToolResult(messages: ModelMessage[]): boolean {
    const seenCallIds = new Set<string>();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
            for (const part of m.content as any[]) {
                if (part?.type === 'tool-call' && part.toolCallId) {
                    seenCallIds.add(part.toolCallId);
                }
            }
        }
        if (m.role === 'tool' && Array.isArray(m.content)) {
            for (const part of m.content as any[]) {
                if (part?.type === 'tool-result' && part.toolCallId) {
                    if (!seenCallIds.has(part.toolCallId)) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

describe('clampMessagesToBudget', () => {
    it('leaves a window that already fits untouched', () => {
        const msgs = buildWindow(2, 100);
        const budget = estimateMessagesTokens(msgs) + 1_000;
        expect(clampMessagesToBudget(msgs, budget)).toBe(msgs);
    });

    it('clamps an overflowing window to at or below the budget', () => {
        // 30 rounds × ~8K-char results — far over any small budget.
        const msgs = buildWindow(30, 8_000);
        const before = estimateMessagesTokens(msgs);
        const budget = 5_000;
        const clamped = clampMessagesToBudget(msgs, budget);
        const after = estimateMessagesTokens(clamped);
        expect(before).toBeGreaterThan(budget);
        expect(after).toBeLessThanOrEqual(budget);
    });

    it('preserves the head (first user diff turn)', () => {
        const msgs = buildWindow(30, 8_000);
        const clamped = clampMessagesToBudget(msgs, 5_000);
        expect(clamped[0].role).toBe('user');
        expect(String(clamped[0].content)).toContain('Review this diff');
    });

    it('never produces an orphaned tool result', () => {
        const msgs = buildWindow(30, 8_000);
        const clamped = clampMessagesToBudget(msgs, 5_000);
        expect(hasOrphanToolResult(clamped)).toBe(false);
    });

    it('fits even when a single recent round alone exceeds the budget', () => {
        // One massive round; budget smaller than it → phase 3 (truncate) fires.
        const msgs = buildWindow(1, 200_000);
        const budget = 1_000;
        const clamped = clampMessagesToBudget(msgs, budget);
        expect(estimateMessagesTokens(clamped)).toBeLessThanOrEqual(budget);
        expect(hasOrphanToolResult(clamped)).toBe(false);
    });

    it('is a no-op for a non-positive budget (nonsensical window)', () => {
        const msgs = buildWindow(2, 100);
        expect(clampMessagesToBudget(msgs, 0)).toBe(msgs);
    });
});

describe('compressMessages (soft pass) still structurally preserves tool turns', () => {
    it('keeps tool content as an array (no re-flatten to string)', () => {
        const msgs = buildWindow(10, 8_000);
        const compressed = compressMessages(msgs, []);
        const toolMsg = compressed.find((m) => m.role === 'tool');
        expect(Array.isArray(toolMsg?.content)).toBe(true);
    });
});
