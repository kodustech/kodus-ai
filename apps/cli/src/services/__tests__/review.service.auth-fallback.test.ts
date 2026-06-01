import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../types/errors.js';

const mocks = vi.hoisted(() => ({
    getPullRequestSuggestions: vi.fn(),
    triggerBusinessValidation: vi.fn(),
    getValidToken: vi.fn(),
    loadConfig: vi.fn(),
}));

vi.mock('../api/index.js', () => ({
    api: {
        review: {
            getPullRequestSuggestions: mocks.getPullRequestSuggestions,
            triggerBusinessValidation: mocks.triggerBusinessValidation,
        },
    },
}));

vi.mock('../auth.service.js', () => ({
    authService: {
        getValidToken: mocks.getValidToken,
    },
}));

vi.mock('../../utils/config.js', () => ({
    loadConfig: mocks.loadConfig,
}));

import { reviewService } from '../review.service.js';

describe('ReviewService getPullRequestSuggestions auth fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('falls back to team key on 401 from personal token', async () => {
        mocks.getValidToken.mockResolvedValue('personal-token');
        mocks.loadConfig.mockResolvedValue({ teamKey: 'kodus_team_key' });
        mocks.getPullRequestSuggestions
            .mockRejectedValueOnce(new ApiError(401, 'Unauthorized'))
            .mockResolvedValueOnce({ summary: 'ok', issues: [] });

        const response = await reviewService.getPullRequestSuggestions({
            prUrl: 'https://github.com/org/repo/pull/1',
        });

        expect(mocks.getPullRequestSuggestions).toHaveBeenCalledTimes(2);
        expect(mocks.getPullRequestSuggestions).toHaveBeenNthCalledWith(
            1,
            'personal-token',
            expect.objectContaining({
                prUrl: 'https://github.com/org/repo/pull/1',
            }),
        );
        expect(mocks.getPullRequestSuggestions).toHaveBeenNthCalledWith(
            2,
            'kodus_team_key',
            expect.objectContaining({
                prUrl: 'https://github.com/org/repo/pull/1',
            }),
        );
        expect(response.result.summary).toBe('ok');
    });

    it('rethrows the fallback error if team-key fallback also fails', async () => {
        const originalError = new ApiError(401, 'Primary auth failed');
        const fallbackError = new ApiError(401, 'Fallback failed');
        mocks.getValidToken.mockResolvedValue('personal-token');
        mocks.loadConfig.mockResolvedValue({ teamKey: 'kodus_team_key' });
        mocks.getPullRequestSuggestions
            .mockRejectedValueOnce(originalError)
            .mockRejectedValueOnce(fallbackError);

        await expect(
            reviewService.getPullRequestSuggestions({
                prUrl: 'https://github.com/org/repo/pull/1',
            }),
        ).rejects.toBe(fallbackError);
    });

    it('does not fallback for non-401 errors', async () => {
        const error = new ApiError(500, 'Server error');
        mocks.getValidToken.mockResolvedValue('personal-token');
        mocks.getPullRequestSuggestions.mockRejectedValue(error);

        await expect(
            reviewService.getPullRequestSuggestions({
                prUrl: 'https://github.com/org/repo/pull/1',
            }),
        ).rejects.toBe(error);
        expect(mocks.loadConfig).not.toHaveBeenCalled();
    });
});

describe('ReviewService triggerBusinessValidation auth fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('falls back to team key on 401 from personal token', async () => {
        const localDiff = 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;';
        mocks.getValidToken.mockResolvedValue('personal-token');
        mocks.loadConfig.mockResolvedValue({ teamKey: 'kodus_team_key' });
        mocks.triggerBusinessValidation
            .mockRejectedValueOnce(new ApiError(401, 'Unauthorized'))
            .mockResolvedValueOnce({
                accepted: true,
                mode: 'local_diff',
                command: 'kodus pr business-validation --task-id KD-1234',
                repositoryName: 'org/repo',
                taskReference: 'KD-1234',
                result: 'ok',
            });

        const response = await reviewService.triggerBusinessValidation({
            diff: localDiff,
            taskId: 'KD-1234',
        });

        expect(mocks.triggerBusinessValidation).toHaveBeenCalledTimes(2);
        expect(mocks.triggerBusinessValidation).toHaveBeenNthCalledWith(
            1,
            'personal-token',
            expect.objectContaining({
                diff: localDiff,
                taskId: 'KD-1234',
            }),
        );
        expect(mocks.triggerBusinessValidation).toHaveBeenNthCalledWith(
            2,
            'kodus_team_key',
            expect.objectContaining({
                diff: localDiff,
                taskId: 'KD-1234',
            }),
        );
        expect(response.accepted).toBe(true);
    });

    it('forwards local diff payload when running without PR context', async () => {
        const localDiff = 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;';
        mocks.getValidToken.mockResolvedValue('kodus_team_key');
        mocks.triggerBusinessValidation.mockResolvedValue({
            accepted: true,
            mode: 'local_diff',
            command: 'kodus pr business-validation --task-id KD-1234',
            repositoryName: 'org/repo',
            taskReference: 'KD-1234',
            result: 'ok',
        });

        const response = await reviewService.triggerBusinessValidation({
            diff: localDiff,
            taskId: 'KD-1234',
        });

        expect(mocks.triggerBusinessValidation).toHaveBeenCalledTimes(1);
        expect(mocks.triggerBusinessValidation).toHaveBeenCalledWith(
            'kodus_team_key',
            expect.objectContaining({
                diff: localDiff,
                taskId: 'KD-1234',
            }),
        );
        expect(response.mode).toBe('local_diff');
    });
});
