import { describe, expect, it, vi } from 'vitest';
import { createTurnLocalState } from '../lifecycle-local-turn-state.js';

describe('createTurnLocalState', () => {
    it('uses the transcript file size as the offset when the file exists', async () => {
        const stat = vi.fn().mockResolvedValue({ size: 321 });

        await expect(
            createTurnLocalState({
                turnId: 'turn-1',
                transcriptPath: '/tmp/transcript.jsonl',
                stat,
            }),
        ).resolves.toEqual({
            turnId: 'turn-1',
            transcriptPath: '/tmp/transcript.jsonl',
            transcriptOffset: 321,
        });
        expect(stat).toHaveBeenCalledWith('/tmp/transcript.jsonl');
    });

    it('falls back to offset zero when there is no transcript path', async () => {
        const stat = vi.fn();

        await expect(
            createTurnLocalState({
                turnId: 'turn-1',
                transcriptPath: '',
                stat,
            }),
        ).resolves.toEqual({
            turnId: 'turn-1',
            transcriptPath: '',
            transcriptOffset: 0,
        });
        expect(stat).not.toHaveBeenCalled();
    });

    it('falls back to offset zero when stat fails', async () => {
        const stat = vi.fn().mockRejectedValue(new Error('missing'));

        await expect(
            createTurnLocalState({
                turnId: 'turn-1',
                transcriptPath: '/tmp/transcript.jsonl',
                stat,
            }),
        ).resolves.toEqual({
            turnId: 'turn-1',
            transcriptPath: '/tmp/transcript.jsonl',
            transcriptOffset: 0,
        });
    });
});
