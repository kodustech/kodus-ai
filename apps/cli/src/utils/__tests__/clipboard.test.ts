import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('clipboardy', () => ({
    default: {
        write: vi.fn(),
    },
}));

import clipboard from 'clipboardy';
import { copyTextToClipboard } from '../clipboard.js';

describe('clipboard util', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns true when clipboard write succeeds', async () => {
        vi.mocked(clipboard.write).mockResolvedValue(undefined);

        const ok = await copyTextToClipboard('hello');

        expect(ok).toBe(true);
        expect(clipboard.write).toHaveBeenCalledWith('hello');
    });

    it('returns false when clipboard write fails', async () => {
        vi.mocked(clipboard.write).mockRejectedValue(
            new Error('clipboard error'),
        );

        const ok = await copyTextToClipboard('hello');

        expect(ok).toBe(false);
    });
});
