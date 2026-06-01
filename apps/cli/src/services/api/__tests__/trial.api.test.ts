import { describe, expect, it, vi } from 'vitest';
import { RealTrialApi } from '../trial.api.js';

describe('RealTrialApi', () => {
    it('requests trial status from the expected endpoint', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            fingerprint: 'fp',
            reviewsUsed: 0,
            reviewsLimit: 5,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt: new Date().toISOString(),
            isLimited: false,
        });

        const api = new RealTrialApi(requestWithRetry);
        await api.getStatus('fp');

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/trial/status?fingerprint=fp',
        );
    });
});
