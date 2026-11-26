import type { AgentMessage } from '@libs/agent-harness/domain/contracts/run-state.contract';

import { withoutThinkingAfterFirstEdit } from './context-compressor';
import { ContextWindowCompressor } from './context-window-compressor';

/**
 * Anthropic signs a thinking block with the conversation before it, and a
 * replayed block whose prefix changed is a 400 ("Invalid `signature` in
 * `thinking` block. The block is bound to a different conversation"). Review
 * batches on large PRs died that way once compression truncated an earlier
 * tool result (Nov 2026). These pin that a compressed window never replays a
 * thinking block after the first message it changed.
 */
describe('ContextWindowCompressor — thinking blocks after an edit', () => {
    // Code-like output: a single repeated character makes BPE quadratic.
    const toolOutput = (i: number) =>
        Array.from({ length: 600 }, (_, n) => `const v${i}_${n} = read(${n});`).join('\n');

    const reasoning = (sig: string) => ({
        type: 'reasoning',
        text: `thinking ${sig}`,
        providerOptions: { anthropic: { signature: sig } },
    });

    function history(rounds: number): AgentMessage[] {
        const messages: any[] = [
            { role: 'system', content: 'You review code.' },
            { role: 'user', content: '<Diffs>small diff</Diffs>' },
        ];
        for (let i = 0; i < rounds; i++) {
            messages.push({
                role: 'assistant',
                content: [
                    reasoning(`sig-${i}`),
                    { type: 'tool-call', toolCallId: `c${i}`, toolName: 'readFile', input: { i } },
                ],
            });
            messages.push({
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: `c${i}`,
                        toolName: 'readFile',
                        output: { type: 'text', value: toolOutput(i) },
                    },
                ],
            });
        }
        return messages as AgentMessage[];
    }

    const signatures = (messages: readonly AgentMessage[]) =>
        messages.flatMap((m: any) =>
            m.role === 'assistant' && Array.isArray(m.content)
                ? m.content
                      .filter((p: any) => p.type === 'reasoning')
                      .map((p: any) => p.providerOptions.anthropic.signature)
                : [],
        );

    it('keeps thinking before the first truncated result and drops it after', () => {
        const messages = history(8);
        const result = new ContextWindowCompressor(40_000).maybeCompress(messages);

        expect(result).not.toBeNull();
        const out = result!.messages;
        // The first tool result (index 3) is old and gets truncated, so only
        // the thinking of the turn before it is still bound to its prefix.
        expect(out[3]).not.toEqual(messages[3]);
        expect(signatures(out)).toEqual(['sig-0']);
        // Text and tool calls of the stripped turns stay.
        const calls = out.flatMap((m: any) =>
            m.role === 'assistant' ? m.content.filter((p: any) => p.type === 'tool-call') : [],
        );
        expect(calls).toHaveLength(8);
    });

    it('keeps the thinking after a result the pass did not shorten', () => {
        const messages = history(8) as any[];
        // The first result fits under every cap, so it is not an edit.
        messages[3] = {
            ...messages[3],
            content: [{ ...messages[3].content[0], output: { type: 'text', value: 'ok' } }],
        };
        const result = new ContextWindowCompressor(40_000).maybeCompress(messages);

        expect(signatures(result!.messages)).toEqual(['sig-0', 'sig-1']);
    });

    it('leaves the window alone when nothing was edited', () => {
        const messages = history(2) as any[];
        expect(withoutThinkingAfterFirstEdit(messages, messages)).toBe(messages);
    });

    it('drops a turn that was only thinking once its thinking goes', () => {
        const original: any[] = [
            { role: 'user', content: 'head' },
            { role: 'tool', content: 'long result' },
            { role: 'assistant', content: [reasoning('only')] },
            { role: 'user', content: 'next' },
        ];
        const edited = [original[0], { role: 'tool', content: 'cut' }, original[2], original[3]];
        expect(withoutThinkingAfterFirstEdit(original, edited)).toEqual([
            original[0],
            edited[1],
            original[3],
        ]);
    });
});
