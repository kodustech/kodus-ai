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

    it('reads the formatted settings the settings pages read, with the file overlay by default', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({ configValue: {} });
        const api = new RealConfigApi(requestWithRetry);

        await api.getFormattedCodeReviewParameter('eyJ.user', 'team 1');
        await api.getFormattedCodeReviewParameter('eyJ.user', 'team-1', {
            includeFileOverlay: false,
        });

        expect(requestWithRetry).toHaveBeenNthCalledWith(
            1,
            '/parameters/code-review-parameter?teamId=team%201',
            { headers: { Authorization: 'Bearer eyJ.user' } },
        );
        expect(requestWithRetry).toHaveBeenNthCalledWith(
            2,
            '/parameters/code-review-parameter?teamId=team-1&includeFileOverlay=false',
            { headers: { Authorization: 'Bearer eyJ.user' } },
        );
    });

    it('saves a partial config at a scope with the web save payload', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({});
        const api = new RealConfigApi(requestWithRetry);

        await api.saveCodeReviewConfig('eyJ.user', {
            teamId: 'team-1',
            configValue: { runOnDraft: false },
            repositoryId: 'repo-1',
            directoryId: 'dir-1',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/parameters/create-or-update-code-review',
            {
                method: 'POST',
                headers: { Authorization: 'Bearer eyJ.user' },
                body: JSON.stringify({
                    configValue: { runOnDraft: false },
                    organizationAndTeamData: { teamId: 'team-1' },
                    repositoryId: 'repo-1',
                    directoryId: 'dir-1',
                }),
            },
        );
    });

    it('reads the LLM config status and tests a model on the org provider', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({});
        const api = new RealConfigApi(requestWithRetry);

        await api.getLLMConfigStatus('eyJ.user');
        await api.testByokModel('eyJ.user', {
            provider: 'anthropic',
            model: 'claude-x',
        });
        await api.getCodeReviewScopes('eyJ.user', 'team-1');

        expect(requestWithRetry).toHaveBeenNthCalledWith(
            1,
            '/organization-parameters/llm-config/status',
            { headers: { Authorization: 'Bearer eyJ.user' } },
        );
        expect(requestWithRetry).toHaveBeenNthCalledWith(
            2,
            '/organization-parameters/test-byok-model',
            {
                method: 'POST',
                headers: { Authorization: 'Bearer eyJ.user' },
                body: JSON.stringify({
                    provider: 'anthropic',
                    model: 'claude-x',
                }),
            },
        );
        expect(requestWithRetry).toHaveBeenNthCalledWith(
            3,
            '/parameters/code-review-scopes?teamId=team-1',
            { headers: { Authorization: 'Bearer eyJ.user' } },
        );
    });
});
