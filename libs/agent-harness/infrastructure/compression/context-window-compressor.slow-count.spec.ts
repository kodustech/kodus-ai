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
});
