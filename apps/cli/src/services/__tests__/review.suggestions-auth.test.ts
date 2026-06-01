import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../types/errors.js';

vi.mock('../api/index.js', () => ({
    api: {
        review: {
            getPullRequestSuggestions: vi.fn(),
        },
    },
}));

vi.mock('../auth.service.js', () => ({
    authService: {
        getValidToken: vi.fn(),
    },
}));

vi.mock('../../utils/config.js', () => ({
    loadConfig: vi.fn(),
}));

import { api } from '../api/index.js';
import { authService } from '../auth.service.js';
import { loadConfig } from '../../utils/config.js';
import { reviewService } from '../review.service.js';

const mockApi = vi.mocked(api);
const mockAuthService = vi.mocked(authService);
const mockLoadConfig = vi.mocked(loadConfig);

describe('ReviewService getPullRequestSuggestions auth fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('falls back to team key when bearer auth returns 401', async () => {
        mockAuthService.getValidToken.mockResolvedValue('eyJ.user.token');
        mockLoadConfig.mockResolvedValue({
            teamKey: 'kodus_team_key',
            teamName: 'Team',
            organizationName: 'Org',
        } as any);

        mockApi.review.getPullRequestSuggestions = vi
            .fn()
            .mockRejectedValueOnce(new ApiError(401, 'Unauthorized'))
            .mockResolvedValueOnce({
                summary: 'Suggestions',
                issues: [],
                filesAnalyzed: 0,
                duration: 0,
            } as any);

        const result = await reviewService.getPullRequestSuggestions({
            prUrl: 'https://github.com/kodustech/cli/pull/6',
        });

        expect(mockApi.review.getPullRequestSuggestions).toHaveBeenCalledTimes(
            2,
        );
        expect(
            mockApi.review.getPullRequestSuggestions,
        ).toHaveBeenNthCalledWith(
            1,
            'eyJ.user.token',
            expect.objectContaining({
                prUrl: 'https://github.com/kodustech/cli/pull/6',
            }),
        );
        expect(
            mockApi.review.getPullRequestSuggestions,
        ).toHaveBeenNthCalledWith(
            2,
            'kodus_team_key',
            expect.objectContaining({
                prUrl: 'https://github.com/kodustech/cli/pull/6',
            }),
        );
        expect(result.result.summary).toBe('Suggestions');
    });

    it('does not fallback when token is already a team key', async () => {
        mockAuthService.getValidToken.mockResolvedValue('kodus_team_key');
        mockApi.review.getPullRequestSuggestions = vi
            .fn()
            .mockRejectedValue(new ApiError(401, 'Unauthorized'));

        await expect(
            reviewService.getPullRequestSuggestions({
                prUrl: 'https://github.com/kodustech/cli/pull/6',
            }),
        ).rejects.toThrow(ApiError);

        expect(mockLoadConfig).not.toHaveBeenCalled();
    });

    it('rethrows when bearer auth fails with 401 and no team key is configured', async () => {
        mockAuthService.getValidToken.mockResolvedValue('eyJ.user.token');
        mockLoadConfig.mockResolvedValue(null);
        mockApi.review.getPullRequestSuggestions = vi
            .fn()
            .mockRejectedValue(new ApiError(401, 'Unauthorized'));

        await expect(
            reviewService.getPullRequestSuggestions({
                prUrl: 'https://github.com/kodustech/cli/pull/6',
            }),
        ).rejects.toThrow(ApiError);
    });

    it('rethrows fallback error when fallback with team key also fails', async () => {
        const originalError = new ApiError(401, 'Bearer unauthorized');
        const fallbackError = new ApiError(401, 'Team key unauthorized');

        mockAuthService.getValidToken.mockResolvedValue('eyJ.user.token');
        mockLoadConfig.mockResolvedValue({
            teamKey: 'kodus_team_key',
            teamName: 'Team',
            organizationName: 'Org',
        } as any);
        mockApi.review.getPullRequestSuggestions = vi
            .fn()
            .mockRejectedValueOnce(originalError)
            .mockRejectedValueOnce(fallbackError);

        await expect(
            reviewService.getPullRequestSuggestions({
                prUrl: 'https://github.com/kodustech/cli/pull/6',
            }),
        ).rejects.toBe(fallbackError);
    });
});
