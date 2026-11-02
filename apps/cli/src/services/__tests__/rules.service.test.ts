import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/index.js', () => ({
    api: {
        rules: {
            createRule: vi.fn(),
            updateRule: vi.fn(),
            viewRules: vi.fn(),
            findRulesAsUser: vi.fn(),
            saveRuleAsUser: vi.fn(),
            changeStatusAsUser: vi.fn(),
        },
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: {
        resolveCredential: vi.fn(),
        resolve: vi.fn(),
    },
}));

import { CommandError } from '../../utils/command-errors.js';
import { api } from '../api/index.js';
import { rulesService } from '../rules.service.js';
import { userContextService } from '../user-context.service.js';

const mockRulesApi = vi.mocked(api.rules);
const mockUserContext = vi.mocked(userContextService);

const USER_CONTEXT = {
    accessToken: 'eyJ.user.token',
    organizationId: 'org-1',
    teamId: 'team-1',
    teamName: 'Platform',
};

function asTeamKey(): void {
    mockUserContext.resolveCredential.mockResolvedValue({
        kind: 'team-key',
        accessToken: 'kodus_team_key',
    });
}

function asUser(): void {
    mockUserContext.resolveCredential.mockResolvedValue({
        kind: 'user',
        accessToken: USER_CONTEXT.accessToken,
    });
    mockUserContext.resolve.mockResolvedValue(USER_CONTEXT);
}

describe('rulesService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('with a team key', () => {
        beforeEach(asTeamKey);

        it('applies severity and scope defaults on create', async () => {
            mockRulesApi.createRule.mockResolvedValue({
                uuid: 'rule-1',
                title: 'Use async/await',
                rule: 'Prefer async/await',
            });

            await rulesService.createRule({
                title: 'Use async/await',
                rule: 'Prefer async/await',
            });

            expect(mockRulesApi.createRule).toHaveBeenCalledWith(
                'kodus_team_key',
                {
                    title: 'Use async/await',
                    rule: 'Prefer async/await',
                    repositoryId: 'global',
                    severity: 'medium',
                    scope: 'file',
                    path: '**/*',
                },
            );
            expect(mockRulesApi.saveRuleAsUser).not.toHaveBeenCalled();
            expect(mockUserContext.resolve).not.toHaveBeenCalled();
        });

        it('uses provided repository id on create', async () => {
            mockRulesApi.createRule.mockResolvedValue({
                uuid: 'rule-2',
                title: 'Use strict equals',
                rule: 'Prefer === and !==',
            });

            await rulesService.createRule({
                title: 'Use strict equals',
                rule: 'Prefer === and !==',
                repositoryId: 'repo-1',
            });

            expect(mockRulesApi.createRule).toHaveBeenCalledWith(
                'kodus_team_key',
                expect.objectContaining({ repositoryId: 'repo-1' }),
            );
        });

        it('sends the scope the review pipeline matches for "pull request"', async () => {
            mockRulesApi.createRule.mockResolvedValue({
                uuid: 'rule-3',
                title: 'PR description',
                rule: 'Explain the change',
            });

            await rulesService.createRule({
                title: 'PR description',
                rule: 'Explain the change',
                scope: 'pull request' as any,
            });

            expect(mockRulesApi.createRule).toHaveBeenCalledWith(
                'kodus_team_key',
                expect.objectContaining({ scope: 'pull-request' }),
            );
        });

        it('passes through centralized PR response on create', async () => {
            mockRulesApi.createRule.mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/1',
                pending: true,
            });

            const result = await rulesService.createRule({
                title: 'Use strict equals',
                rule: 'Prefer === and !==',
                repositoryId: 'repo-1',
            });

            expect(result).toEqual(
                expect.objectContaining({ mode: 'centralized-pr' }),
            );
        });

        it('updates through the team-key route', async () => {
            mockRulesApi.updateRule.mockResolvedValue({
                uuid: 'rule-1',
                title: 'New',
                rule: 'Desc',
            });

            await rulesService.updateRule({ ruleId: 'rule-1', title: 'New' });

            expect(mockRulesApi.updateRule).toHaveBeenCalledWith(
                'kodus_team_key',
                'rule-1',
                { title: 'New' },
            );
            expect(mockRulesApi.findRulesAsUser).not.toHaveBeenCalled();
        });

        it('uses ruleId precedence for view queries', async () => {
            mockRulesApi.viewRules.mockResolvedValue([]);

            await rulesService.viewRules({
                ruleId: 'rule-9',
                repositoryId: 'repo-7',
            });

            expect(mockRulesApi.viewRules).toHaveBeenCalledWith(
                'kodus_team_key',
                {
                    repositoryId: 'repo-7',
                    ruleId: 'rule-9',
                },
            );
        });

        it('rejects pause, resume and delete with a login hint', async () => {
            mockUserContext.resolve.mockRejectedValue(
                new CommandError(
                    'AUTH_REQUIRED',
                    'Deleting, pausing or resuming Kody Rules requires a logged-in user. Run: kodus auth login',
                ),
            );

            await expect(
                rulesService.changeStatus(['rule-1'], 'paused'),
            ).rejects.toEqual(
                expect.objectContaining<Partial<CommandError>>({
                    code: 'AUTH_REQUIRED',
                }),
            );
            expect(mockRulesApi.changeStatusAsUser).not.toHaveBeenCalled();
        });
    });

    describe('with a logged-in user', () => {
        beforeEach(asUser);

        it('creates through the web endpoint with the CLI defaults', async () => {
            mockRulesApi.saveRuleAsUser.mockResolvedValue({
                uuid: 'rule-1',
                title: 'Use async/await',
                rule: 'Prefer async/await',
            });

            await rulesService.createRule(
                { title: 'Use async/await', rule: 'Prefer async/await' },
                { team: 'Platform' },
            );

            expect(mockUserContext.resolve).toHaveBeenCalledWith('Kody Rules', {
                team: 'Platform',
            });
            expect(mockRulesApi.saveRuleAsUser).toHaveBeenCalledWith(
                'eyJ.user.token',
                {
                    title: 'Use async/await',
                    rule: 'Prefer async/await',
                    type: 'standard',
                    severity: 'medium',
                    scope: 'file',
                    path: '**/*',
                    repositoryId: 'global',
                    origin: 'cli',
                    status: 'active',
                    examples: [],
                    teamId: 'team-1',
                },
            );
            expect(mockRulesApi.createRule).not.toHaveBeenCalled();
        });

        it('updates by merging the changes over the stored rule', async () => {
            mockRulesApi.findRulesAsUser.mockResolvedValue([
                {
                    uuid: 'rule-1',
                    title: 'Old title',
                    rule: 'Old body',
                    severity: 'high',
                    type: 'standard',
                },
            ]);
            mockRulesApi.saveRuleAsUser.mockResolvedValue({
                uuid: 'rule-1',
                title: 'New title',
                rule: 'Old body',
            });

            await rulesService.updateRule({
                ruleId: 'rule-1',
                title: 'New title',
            });

            expect(mockRulesApi.findRulesAsUser).toHaveBeenCalledWith(
                'eyJ.user.token',
                { ruleId: 'rule-1' },
            );
            expect(mockRulesApi.saveRuleAsUser).toHaveBeenCalledWith(
                'eyJ.user.token',
                {
                    uuid: 'rule-1',
                    type: 'standard',
                    title: 'New title',
                    rule: 'Old body',
                    severity: 'high',
                    teamId: 'team-1',
                },
            );
        });

        it('fails an update of a rule it cannot find', async () => {
            mockRulesApi.findRulesAsUser.mockResolvedValue([]);

            await expect(
                rulesService.updateRule({ ruleId: 'missing', title: 'X' }),
            ).rejects.toEqual(
                expect.objectContaining<Partial<CommandError>>({
                    code: 'INVALID_INPUT',
                }),
            );
            expect(mockRulesApi.saveRuleAsUser).not.toHaveBeenCalled();
        });

        it('views through the web endpoint', async () => {
            mockRulesApi.findRulesAsUser.mockResolvedValue([]);

            await rulesService.viewRules({ repositoryId: 'repo-7' });

            expect(mockRulesApi.findRulesAsUser).toHaveBeenCalledWith(
                'eyJ.user.token',
                { repositoryId: 'repo-7', ruleId: undefined },
            );
            expect(mockRulesApi.viewRules).not.toHaveBeenCalled();
        });

        it.each(['deleted', 'paused', 'active'] as const)(
            'changes status to %s for every distinct uuid',
            async (status) => {
                mockRulesApi.changeStatusAsUser.mockResolvedValue([]);

                await rulesService.changeStatus(
                    ['rule-1', ' rule-2 ', 'rule-1', ''],
                    status,
                );

                expect(mockRulesApi.changeStatusAsUser).toHaveBeenCalledWith(
                    'eyJ.user.token',
                    {
                        ruleIds: ['rule-1', 'rule-2'],
                        status,
                        teamId: 'team-1',
                    },
                );
            },
        );

        it('returns the centralized PR when the status change is proposed', async () => {
            mockRulesApi.changeStatusAsUser.mockResolvedValue({
                mode: 'centralized-pr',
                prUrl: 'https://example.com/pr/2',
            });

            const result = await rulesService.changeStatus(
                ['rule-1'],
                'deleted',
            );

            expect(result).toEqual(
                expect.objectContaining({ mode: 'centralized-pr' }),
            );
        });

        it('requires at least one uuid for a status change', async () => {
            await expect(
                rulesService.changeStatus(['', ' '], 'paused'),
            ).rejects.toEqual(
                expect.objectContaining<Partial<CommandError>>({
                    code: 'INVALID_INPUT',
                }),
            );
            expect(mockUserContext.resolve).not.toHaveBeenCalled();
        });
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
        expect(mockUserContext.resolveCredential).not.toHaveBeenCalled();
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
});
