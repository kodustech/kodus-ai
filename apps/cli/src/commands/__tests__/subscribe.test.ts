import { describe, expect, it, vi } from 'vitest';
import { openSubscriptionPage } from '../subscribe.js';

describe('subscribe command helpers', () => {
    it('opens subscription page when open succeeds', async () => {
        const openUrl = vi.fn().mockResolvedValue(undefined);

        const opened = await openSubscriptionPage(openUrl);

        expect(opened).toBe(true);
        expect(openUrl).toHaveBeenCalledWith('https://kodus.io/pricing');
    });

    it('returns false when open fails', async () => {
        const openUrl = vi.fn().mockRejectedValue(new Error('open failed'));

        const opened = await openSubscriptionPage(openUrl);

        expect(opened).toBe(false);
    });
});
