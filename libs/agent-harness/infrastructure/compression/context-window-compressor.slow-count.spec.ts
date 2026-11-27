import type { AgentMessage } from '@libs/agent-harness/domain/contracts/run-state.contract';

import { ContextWindowCompressor } from './context-window-compressor';

// Records what a slow count would log, without waiting for a slow count.
const logged: Array<Record<string, unknown>> = [];
jest.mock('@libs/core/infrastructure/activity/time-sync', () => ({
    timeSync: (_label: string, fn: () => unknown, meta?: () => Record<string, unknown>) => {
        if (meta) logged.push(meta());
        return fn();
    },
}));

/**
 * A slow token count (1.3-1.6 s, dozens per large PR in Nov 2026) logged only
 * how many messages it counted, which cannot tell a huge head from a long
 * history. The log now carries the sizes that decide the fix.
 */
describe('ContextWindowCompressor — slow count log', () => {
    it('logs the window size and its largest message, never its text', () => {
        logged.length = 0;
        const head = 'diff line\n'.repeat(5_000);
        const messages = [
            { role: 'system', content: 'You review code.' },
            { role: 'user', content: head },
        ] as AgentMessage[];

        new ContextWindowCompressor(1_000_000, { countAtWorstCase: true }).maybeCompress(
            messages,
        );

        // Sizes only: nothing of the messages themselves reaches the log.
        expect(JSON.stringify(logged)).not.toContain('diff line');
        expect(logged[0]).toEqual({
            messages: 2,
            chars: 'You review code.'.length + head.length,
            largestChars: head.length,
            largestRole: 'user',
            worstCase: true,
        });
    });

    it('measures parts by their serialized size and finds the largest wherever it is', () => {
        logged.length = 0;
        const parts = [{ type: 'text', text: 'z'.repeat(9_000) }];
        const messages = [
            { role: 'user', content: parts },
            { role: 'assistant', content: 'short answer' },
        ] as AgentMessage[];

        new ContextWindowCompressor(1_000_000).maybeCompress(messages);

        expect(logged[0]).toEqual({
            messages: 2,
            chars: JSON.stringify(parts).length + 'short answer'.length,
            largestChars: JSON.stringify(parts).length,
            largestRole: 'user',
            worstCase: false,
        });
    });

    it('names no largest message when every message is empty', () => {
        logged.length = 0;
        new ContextWindowCompressor(1_000_000).maybeCompress([
            { role: 'user', content: '' },
        ] as AgentMessage[]);

        expect(logged[0]).toEqual({
            messages: 1,
            chars: 0,
            largestChars: 0,
            largestRole: '',
            worstCase: false,
        });
    });
});
