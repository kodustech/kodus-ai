import { describe, expect, it, vi } from 'vitest';
import { RealRulesApi } from '../rules.api.js';

describe('RealRulesApi', () => {
    it('creates a rule with team-key auth', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            uuid: 'rule-1',
            repositoryId: 'repo-1',
            title: 'Use async/await',
            rule: 'Prefer async/await over raw promises',
            severity: 'high',
            scope: 'file',
            path: '**/*.ts',
        });

        const api = new RealRulesApi(requestWithRetry);
        await api.createRule('kodus_team_key', {
            title: 'Use async/await',
            rule: 'Prefer async/await over raw promises',
            repositoryId: 'repo-1',
            severity: 'high',
            scope: 'file',
            path: '**/*.ts',
        });

        expect(requestWithRetry).toHaveBeenCalledWith('/cli/kody-rules', {
            method: 'POST',
            headers: {
                'X-Team-Key': 'kodus_team_key',
            },
            body: JSON.stringify({
                title: 'Use async/await',
                rule: 'Prefer async/await over raw promises',
                repositoryId: 'repo-1',
                severity: 'high',
                scope: 'file',
                path: '**/*.ts',
            }),
        });
    });

    it('updates a rule with bearer auth', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            uuid: 'rule-1',
            title: 'Use async/await',
            rule: 'Updated description',
            severity: 'critical',
            scope: 'file',
        });

        const api = new RealRulesApi(requestWithRetry);
        await api.updateRule('eyJ.test.token', 'rule-1', {
            rule: 'Updated description',
            severity: 'critical',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/kody-rules/rule-1',
            {
                method: 'PATCH',
                headers: {
                    Authorization: 'Bearer eyJ.test.token',
                },
                body: JSON.stringify({
                    rule: 'Updated description',
                    severity: 'critical',
                }),
            },
        );
    });

    it('supports centralized PR response payload for create', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/88',
            pending: true,
        });

        const api = new RealRulesApi(requestWithRetry);
        const result = await api.createRule('kodus_team_key', {
            title: 'Use async/await',
            rule: 'Prefer async/await over raw promises',
            repositoryId: 'repo-1',
            severity: 'high',
            scope: 'file',
            path: '**/*.ts',
        });

        expect(result).toEqual(
            expect.objectContaining({ mode: 'centralized-pr' }),
        );
    });

    it('views rules by filters', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue([]);

        const api = new RealRulesApi(requestWithRetry);
        await api.viewRules('kodus_team_key', {
            repositoryId: 'repo-22',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/kody-rules?repositoryId=repo-22',
            {
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
            },
        );

        await api.viewRules('kodus_team_key', {
            ruleId: 'rule-99',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/kody-rules?ruleId=rule-99',
            {
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
            },
        );

        await api.viewRules('kodus_team_key', {
            repositoryId: 'repo-22',
            ruleId: 'rule-99',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/kody-rules?repositoryId=repo-22&ruleId=rule-99',
            {
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
            },
        );
    });

    it('views all rules when no query is provided', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue([]);

        const api = new RealRulesApi(requestWithRetry);
        await api.viewRules('kodus_team_key');

        expect(requestWithRetry).toHaveBeenCalledWith('/cli/kody-rules', {
            headers: {
                'X-Team-Key': 'kodus_team_key',
            },
        });
    });
});
