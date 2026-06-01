import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../types/errors.js';
import { withTeamKeyFallback } from '../review-auth-fallback.js';

describe('withTeamKeyFallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('retries with team key after a 401 from a non-team token', async () => {
        const loadConfig = vi.fn().mockResolvedValue({ teamKey: 'kodus_team' });
        const operation = vi
            .fn()
            .mockRejectedValueOnce(new ApiError(401, 'Unauthorized'))
            .mockResolvedValueOnce('ok');

        await expect(
            withTeamKeyFallback({
                token: 'eyJ.user.token',
                loadConfig,
                operation,
            }),
        ).resolves.toBe('ok');

        expect(operation).toHaveBeenNthCalledWith(1, 'eyJ.user.token');
        expect(operation).toHaveBeenNthCalledWith(2, 'kodus_team');
    });

    it('rethrows the fallback error when fallback also fails', async () => {
        const originalError = new ApiError(401, 'Primary unauthorized');
        const fallbackError = new ApiError(401, 'Fallback unauthorized');
        const loadConfig = vi.fn().mockResolvedValue({ teamKey: 'kodus_team' });
        const operation = vi
            .fn()
            .mockRejectedValueOnce(originalError)
            .mockRejectedValueOnce(fallbackError);

        await expect(
            withTeamKeyFallback({
                token: 'eyJ.user.token',
                loadConfig,
                operation,
            }),
        ).rejects.toBe(fallbackError);
    });

    it('does not fallback for team-key tokens', async () => {
        const error = new ApiError(401, 'Unauthorized');
        const loadConfig = vi.fn();
        const operation = vi.fn().mockRejectedValue(error);

        await expect(
            withTeamKeyFallback({
                token: 'kodus_team',
                loadConfig,
                operation,
            }),
        ).rejects.toBe(error);

        expect(loadConfig).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not fallback for non-401 errors', async () => {
        const error = new ApiError(500, 'Server error');
        const loadConfig = vi.fn();
        const operation = vi.fn().mockRejectedValue(error);

        await expect(
            withTeamKeyFallback({
                token: 'eyJ.user.token',
                loadConfig,
                operation,
            }),
        ).rejects.toBe(error);

        expect(loadConfig).not.toHaveBeenCalled();
    });

    it('rethrows when no team key is configured', async () => {
        const error = new ApiError(401, 'Unauthorized');
        const loadConfig = vi.fn().mockResolvedValue(null);
        const operation = vi.fn().mockRejectedValue(error);

        await expect(
            withTeamKeyFallback({
                token: 'eyJ.user.token',
                loadConfig,
                operation,
            }),
        ).rejects.toBe(error);
    });
});
