import { describe, expect, it, vi } from 'vitest';
import { RealConfigApi } from '../config.api.js';

describe('RealConfigApi', () => {
    it('uses X-Team-Key for repository settings reads with team key auth', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            reviewEnabled: true,
            autoApproveEnabled: false,
            requestChangesMinSeverity: 'high',
            ignoredFilePatterns: [],
            baseBranchPatterns: [],
            ignoredTitlePatterns: [],
        });

        const api = new RealConfigApi(requestWithRetry);
        await api.getRepositorySettings('kodus_team_key', 'repo-1');

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/config/repositories/repo-1/settings',
            {
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
            },
        );
    });

    it('uses Authorization for repository settings updates with bearer auth', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            reviewEnabled: true,
            autoApproveEnabled: true,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['draft*'],
        });

        const api = new RealConfigApi(requestWithRetry);
        await api.updateRepositorySettings('eyJ.test.token', 'repo-1', {
            reviewEnabled: true,
            autoApproveEnabled: true,
            requestChangesMinSeverity: 'critical',
            ignoredFilePatterns: ['dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['draft*'],
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/config/repositories/repo-1/settings',
            {
                method: 'PATCH',
                headers: {
                    Authorization: 'Bearer eyJ.test.token',
                },
                body: JSON.stringify({
                    reviewEnabled: true,
                    autoApproveEnabled: true,
                    requestChangesMinSeverity: 'critical',
                    ignoredFilePatterns: ['dist/**'],
                    baseBranchPatterns: ['main'],
                    ignoredTitlePatterns: ['draft*'],
                }),
            },
        );
    });
});
