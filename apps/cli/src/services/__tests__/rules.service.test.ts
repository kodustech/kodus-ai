import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
    api: {
        rules: {
            createRule: vi.fn(),
            updateRule: vi.fn(),
            viewRules: vi.fn(),
        },
    },
}));

vi.mock('../../utils/team-key-auth.js', () => ({
    resolveTeamKeyAccess: vi.fn(),
}));

import { CommandError } from '../../utils/command-errors.js';
import { resolveTeamKeyAccess } from '../../utils/team-key-auth.js';
import { api } from '../api/index.js';
import { rulesService } from '../rules.service.js';

const mockRulesApi = vi.mocked(api.rules);
const mockResolveTeamKeyAccess = vi.mocked(resolveTeamKeyAccess);

describe('rulesService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockResolveTeamKeyAccess.mockResolvedValue({ teamKey: 'kodus_team_key' });
    });

    it('requires team-key auth on create', async () => {
        mockResolveTeamKeyAccess.mockRejectedValue(
            new CommandError(
                'AUTH_REQUIRED',
                'Kody Rules commands require team-key auth.',
            ),
        );

        await expect(
            rulesService.createRule({ title: 'Rule', rule: 'Desc' }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'AUTH_REQUIRED',
            }),
        );
        expect(mockRulesApi.createRule).not.toHaveBeenCalled();
    });

    it('applies severity and scope defaults on create', async () => {
        mockRulesApi.createRule.mockResolvedValue({
            uuid: 'rule-1',
            repositoryId: 'global',
            title: 'Use async/await',
            rule: 'Prefer async/await',
            severity: 'medium',
            scope: 'file',
            path: '**/*',
        });

        await rulesService.createRule({
            title: 'Use async/await',
            rule: 'Prefer async/await',
        });

        expect(mockRulesApi.createRule).toHaveBeenCalledWith('kodus_team_key', {
            title: 'Use async/await',
            rule: 'Prefer async/await',
            repositoryId: 'global',
            severity: 'medium',
            scope: 'file',
            path: '**/*',
        });
    });

    it('uses provided repository id on create', async () => {
        mockRulesApi.createRule.mockResolvedValue({
            uuid: 'rule-2',
            repositoryId: 'repo-1',
            title: 'Use strict equals',
            rule: 'Prefer === and !==',
            severity: 'medium',
            scope: 'file',
            path: '**/*',
        });

        await rulesService.createRule({
            title: 'Use strict equals',
            rule: 'Prefer === and !==',
            repositoryId: 'repo-1',
        });

        expect(mockRulesApi.createRule).toHaveBeenCalledWith('kodus_team_key', {
            title: 'Use strict equals',
            rule: 'Prefer === and !==',
            repositoryId: 'repo-1',
            severity: 'medium',
            scope: 'file',
            path: '**/*',
        });
    });

    it('passes through centralized PR response on create', async () => {
        mockRulesApi.createRule.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/1',
            pending: true,
        } as any);

        const result = await rulesService.createRule({
            title: 'Use strict equals',
            rule: 'Prefer === and !==',
            repositoryId: 'repo-1',
        });

        expect(result).toEqual(
            expect.objectContaining({ mode: 'centralized-pr' }),
        );
    });

    it('validates severity values', async () => {
        await expect(
            rulesService.createRule({
                title: 'Rule',
                rule: 'Desc',
                severity: 'urgent' as any,
            }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
    });

    it('requires at least one field for update', async () => {
        await expect(
            rulesService.updateRule({
                ruleId: 'rule-1',
            }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
    });

    it('requires rule-id for updates', async () => {
        await expect(
            rulesService.updateRule({
                ruleId: '',
                rule: 'updated',
            }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<CommandError>>({
                code: 'INVALID_INPUT',
            }),
        );
    });

    it('uses ruleId precedence for view queries', async () => {
        mockRulesApi.viewRules.mockResolvedValue([]);

        await rulesService.viewRules({
            ruleId: 'rule-9',
            repositoryId: 'repo-7',
        });

        expect(mockRulesApi.viewRules).toHaveBeenCalledWith('kodus_team_key', {
            repositoryId: 'repo-7',
            ruleId: 'rule-9',
        });
    });
});
