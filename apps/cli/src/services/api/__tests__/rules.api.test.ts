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

    describe('logged-in user (web endpoints)', () => {
        const bearer = { Authorization: 'Bearer eyJ.user.token' };

        it('looks up one rule by uuid', async () => {
            const requestWithRetry = vi.fn().mockResolvedValue([]);
            const api = new RealRulesApi(requestWithRetry);

            await api.findRulesAsUser('eyJ.user.token', {
                ruleId: 'rule-1',
                repositoryId: 'repo-1',
            });

            expect(requestWithRetry).toHaveBeenCalledWith(
                '/kody-rules/find-rules-in-organization-by-filter?key=uuid&value=rule-1',
                { headers: bearer },
            );
        });

        it('lists rules of a repository', async () => {
            const requestWithRetry = vi.fn().mockResolvedValue([]);
            const api = new RealRulesApi(requestWithRetry);

            await api.findRulesAsUser('eyJ.user.token', {
                repositoryId: 'repo-1',
            });

            expect(requestWithRetry).toHaveBeenCalledWith(
                '/kody-rules/find-rules-in-organization-by-filter?repositoryId=repo-1',
                { headers: bearer },
            );
        });

        it('saves through create-or-update', async () => {
            const requestWithRetry = vi.fn().mockResolvedValue({});
            const api = new RealRulesApi(requestWithRetry);
            const payload = {
                title: 'T',
                rule: 'R',
                type: 'standard',
                severity: 'medium' as const,
                teamId: 'team-1',
            };

            await api.saveRuleAsUser('eyJ.user.token', payload);

            expect(requestWithRetry).toHaveBeenCalledWith(
                '/kody-rules/create-or-update',
                {
                    method: 'POST',
                    headers: bearer,
                    body: JSON.stringify(payload),
                },
            );
        });

        it('changes status through change-status-kody-rules', async () => {
            const requestWithRetry = vi.fn().mockResolvedValue([]);
            const api = new RealRulesApi(requestWithRetry);
            const payload = {
                ruleIds: ['rule-1', 'rule-2'],
                status: 'paused' as const,
                teamId: 'team-1',
            };

            await api.changeStatusAsUser('eyJ.user.token', payload);

            expect(requestWithRetry).toHaveBeenCalledWith(
                '/kody-rules/change-status-kody-rules',
                {
                    method: 'POST',
                    headers: bearer,
                    body: JSON.stringify(payload),
                },
            );
        });
    });
});
