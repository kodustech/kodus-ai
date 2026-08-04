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

describe('structured tool-result output survives truncation (PR#302 regression)', () => {
    // ai@7 emits tool-result `output` as a discriminated object
    // ({ type:'text', value }). The old truncation JSON-stringified the whole
    // object into a *string*, dropping `type`; @ai-sdk/openai then serialized a
    // `function_call_output` with no `output` field → OpenAI 400
    // "Missing required parameter: 'input[N].output'". Truncation must keep the
    // { type, value } shape and only shrink the inner text.
    function structuredWindow(valueChars: number): ModelMessage[] {
        return [
            { role: 'user', content: 'Review this diff:\n' + 'x'.repeat(2_000) },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'c1',
                        toolName: 'grep',
                        input: { pattern: 'foo' },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'c1',
                        toolName: 'grep',
                        output: { type: 'text', value: 'z'.repeat(valueChars) },
                    },
                ],
            },
        ];
    }

    function firstToolOutput(messages: ModelMessage[]): any {
        const toolMsg = messages.find((m) => m.role === 'tool');
        return (toolMsg?.content as any[])[0].output;
    }

    it('clampMessagesToBudget keeps output a { type, value } object, not a string', () => {
        const clamped = clampMessagesToBudget(structuredWindow(40_000), 50);
        const out = firstToolOutput(clamped);

        expect(typeof out).toBe('object');
        expect(out.type).toBe('text');
        expect(typeof out.value).toBe('string');
        // inner text was actually shrunk (compression still does its job)...
        expect(out.value.length).toBeLessThan(40_000);
        expect(out.value.endsWith('…[truncated]')).toBe(true);
    });

    it('compressMessages (soft pass) preserves the structured output shape', () => {
        const compressed = compressMessages(structuredWindow(20_000), []);
        const out = firstToolOutput(compressed);

        expect(typeof out).toBe('object');
        expect(out.type).toBe('text');
        expect(typeof out.value).toBe('string');
    });

    it('shrinks a large json output while keeping the { type:"json" } wrapper (fit guarantee, #1574)', () => {
        const window = structuredWindow(1);
        (window.find((m) => m.role === 'tool')!.content as any[])[0].output = {
            type: 'json',
            value: { files: Array.from({ length: 4_000 }, (_, i) => `f${i}.ts`) },
        };
        const budget = 500;
        const clamped = clampMessagesToBudget(window, budget);
        const out = firstToolOutput(clamped);

        // Wrapper preserved so the provider can still serialize a valid output...
        expect(out.type).toBe('json');
        // ...but the payload is shrunk (as a string) so the hard clamp reaches
        // budget — leaving the object intact would re-open #1574.
        expect(typeof out.value).toBe('string');
        expect(estimateMessagesTokens(clamped)).toBeLessThanOrEqual(budget);
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
