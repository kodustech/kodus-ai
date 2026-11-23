/**
 * context-compressor unit tests — hard per-request clamp (issue #1574).
 *
 * The clamp must GUARANTEE the returned window fits a real token budget while
 * keeping the message structure valid for the AI SDK (no orphaned tool result:
 * every `tool` message stays paired with the assistant turn it answers).
 */
import { createHash } from 'crypto';

import {
    clampMessagesToBudget,
    compressMessages,
    estimateMessagesTokens,
    type ModelMessage,
} from './context-compressor';

/**
 * Build a realistic tool-loop window: head user (diff) + N assistant/tool rounds.
 *
 * Keep `resultChars` modest: the estimator runs tiktoken, and BPE on one long
 * run of the same character is quadratic (a 200k-char result took ~22s). Any
 * result above the 500-char hard-clamp cap leaves phase 1 with byte-identical
 * content, so larger inputs exercise nothing extra.
 */
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
        // 30 rounds × 2K-char results (~15K tokens) — far over a small budget.
        const msgs = buildWindow(30, 2_000);
        const before = estimateMessagesTokens(msgs);
        const budget = 5_000;
        const clamped = clampMessagesToBudget(msgs, budget);
        const after = estimateMessagesTokens(clamped);
        expect(before).toBeGreaterThan(budget);
        expect(after).toBeLessThanOrEqual(budget);
    });

    it('preserves the head (first user diff turn)', () => {
        const msgs = buildWindow(30, 2_000);
        const clamped = clampMessagesToBudget(msgs, 5_000);
        expect(clamped[0].role).toBe('user');
        expect(String(clamped[0].content)).toContain('Review this diff');
    });

    it('never produces an orphaned tool result', () => {
        const msgs = buildWindow(30, 2_000);
        const clamped = clampMessagesToBudget(msgs, 5_000);
        expect(hasOrphanToolResult(clamped)).toBe(false);
    });

    it('fits even when a single recent round alone exceeds the budget', () => {
        // One round (~2K tokens) bigger than the whole budget.
        const msgs = buildWindow(1, 8_000);
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
            {
                role: 'user',
                content: 'Review this diff:\n' + 'x'.repeat(2_000),
            },
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
        const clamped = clampMessagesToBudget(structuredWindow(4_000), 50);
        const out = firstToolOutput(clamped);

        expect(typeof out).toBe('object');
        expect(out.type).toBe('text');
        expect(typeof out.value).toBe('string');
        // inner text was actually shrunk (compression still does its job)...
        expect(out.value.length).toBeLessThan(4_000);
        expect(out.value.endsWith('…[truncated]')).toBe(true);
    });

    it('shrinks a large unrecognized/future output type so the hard clamp still fits (#1574)', () => {
        const window = structuredWindow(1);
        (window.find((m) => m.role === 'tool')!.content as any[])[0].output = {
            type: 'future-output-type',
            value: {
                data: Array.from({ length: 4_000 }, (_, i) => `item${i}`),
            },
        };
        const budget = 500;
        const clamped = clampMessagesToBudget(window, budget);
        const out = firstToolOutput(clamped);

        expect(out.type).toBe('text'); // re-typed to a serializable preview
        expect(typeof out.value).toBe('string');
        expect(estimateMessagesTokens(clamped)).toBeLessThanOrEqual(budget);
    });

    it('compressMessages (soft pass) preserves the structured output shape', () => {
        const compressed = compressMessages(structuredWindow(20_000), []);
        const out = firstToolOutput(compressed);

        expect(typeof out).toBe('object');
        expect(out.type).toBe('text');
        expect(typeof out.value).toBe('string');
    });

    // Both object- and array-valued json payloads must shrink so the hard clamp
    // reaches budget (#1574). Once truncated the value is no longer valid JSON,
    // so it is re-typed to `text` — a provider-serializable lossy preview.
    it.each([
        [
            'object',
            { files: Array.from({ length: 4_000 }, (_, i) => `f${i}.ts`) },
        ],
        ['array', Array.from({ length: 5_000 }, (_, i) => `f${i}.ts`)],
    ])(
        'shrinks a large json output (%s value) and re-types it to text',
        (_label, jsonValue) => {
            const window = structuredWindow(1);
            (
                window.find((m) => m.role === 'tool')!.content as any[]
            )[0].output = {
                type: 'json',
                value: jsonValue,
            };
            const budget = 500;
            const clamped = clampMessagesToBudget(window, budget);
            const out = firstToolOutput(clamped);

            // Re-typed to a serializable text preview (no longer a json blob that
            // lies about being parseable)...
            expect(out.type).toBe('text');
            expect(typeof out.value).toBe('string');
            expect(out.value.endsWith('…[truncated]')).toBe(true);
            // ...and the hard clamp actually reached budget.
            expect(estimateMessagesTokens(clamped)).toBeLessThanOrEqual(budget);
        },
    );
});

describe('compressMessages (soft pass) still structurally preserves tool turns', () => {
    it('keeps tool content as an array (no re-flatten to string)', () => {
        const msgs = buildWindow(10, 8_000);
        const compressed = compressMessages(msgs, []);
        const toolMsg = compressed.find((m) => m.role === 'tool');
        expect(Array.isArray(toolMsg?.content)).toBe(true);
    });
});

describe('estimateMessagesTokens — per-run counts', () => {
    const head = () =>
        ({
            role: 'user',
            // Above the 200k-char bound below which counts are not kept.
            content: 'diff and graph context '.repeat(9_000),
        }) as any;

    it('reuses the count of a rebuilt message with the same content', () => {
        const counts = new Map<string, number>();
        const first = estimateMessagesTokens([head()], counts);
        expect(counts.size).toBe(1);
        // Seed the key with a marker: a lookup returns it, a recount would not.
        const [key] = counts.keys();
        counts.set(key, 7);
        expect(estimateMessagesTokens([head()], counts)).toBe(7);
        expect(first).toBe(estimateMessagesTokens([head()]));
    });

    it('keeps a digest per message, never the serialized text', () => {
        const counts = new Map<string, number>();
        const big = {
            role: 'user',
            content: 'const value = compute(input);\n'.repeat(20_000),
        } as any;
        estimateMessagesTokens([big, head()], counts);
        expect(counts.size).toBe(2);
        // A 600k-char head held as a key would stay alive for the whole run,
        // and a SHA-1 key could be collided by content the PR controls.
        const sha256 = (msg: unknown) =>
            createHash('sha256').update(JSON.stringify(msg)).digest('base64');
        expect([...counts.keys()].sort()).toEqual(
            [sha256(big), sha256(head())].sort(),
        );
    });
});

describe('estimateMessagesTokens — per-run counts bounds', () => {
    const big = (tag: string) =>
        ({
            role: 'user',
            content:
                `${tag} ` + 'const value = compute(input);\n'.repeat(7_000),
        }) as any;
    const sha256 = (msg: unknown) =>
        createHash('sha256').update(JSON.stringify(msg)).digest('base64');

    it('keeps the head while newer entries fill the map (LRU on hit)', () => {
        const counts = new Map<string, number>();
        estimateMessagesTokens([big('head')], counts);
        for (let i = 0; i < 255; i++) counts.set(`filler-${i}`, 1);
        estimateMessagesTokens([big('head')], counts); // hit: now the newest
        estimateMessagesTokens([big('other')], counts); // evicts one entry
        expect(counts.size).toBe(256);
        expect(counts.has(sha256(big('head')))).toBe(true);
        expect(counts.has('filler-0')).toBe(false);
    });

    it('never holds more than 256 entries', () => {
        const counts = new Map<string, number>();
        for (let i = 0; i < 256; i++) counts.set(`filler-${i}`, 1);
        estimateMessagesTokens([big('new')], counts);
        expect(counts.size).toBe(256);
    });

    it('leaves messages up to 200k chars to the shared memo', () => {
        const counts = new Map<string, number>();
        const mid = {
            role: 'user',
            content: 'const value = compute(input);\n'.repeat(5_000),
        } as any; // ~150k chars
        estimateMessagesTokens([{ role: 'user', content: 'hi' }, mid], counts);
        expect(counts.size).toBe(0);
    });

    it('counts a message whose toJSON gives undefined as the uncached path does', () => {
        const odd = [
            { role: 'user', content: 'x', toJSON: () => undefined },
        ] as any[];
        expect(estimateMessagesTokens(odd, new Map())).toBe(
            estimateMessagesTokens(odd),
        );
    });

    it('counts null and non-objects as the uncached path does', () => {
        const counts = new Map<string, number>();
        const odd = [null, undefined, 42] as any[];
        expect(estimateMessagesTokens(odd, counts)).toBe(
            estimateMessagesTokens(odd),
        );
    });
});
