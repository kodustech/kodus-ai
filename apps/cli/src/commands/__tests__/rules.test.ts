import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliExitError } from '../../utils/cli-exit.js';

vi.mock('../../services/rules.service.js', () => ({
    rulesService: {
        createRule: vi.fn(),
        updateRule: vi.fn(),
        viewRules: vi.fn(),
        changeStatus: vi.fn(),
    },
}));

import { rulesService } from '../../services/rules.service.js';
import {
    rulesCommand,
    rulesCreateAction,
    rulesDeleteAction,
    rulesPauseAction,
    rulesResumeAction,
    rulesUpdateAction,
    rulesViewAction,
} from '../rules.js';

const mockRulesService = vi.mocked(rulesService);

describe('rules command actions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates a rule and prints success output', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRulesService.createRule.mockResolvedValue({
            uuid: 'rule-1',
            repositoryId: 'global',
            title: 'Use async/await',
            rule: 'Prefer async/await',
            severity: 'high',
            scope: 'file',
            path: '**/*.ts',
        });

        await rulesCreateAction({
            title: 'Use async/await',
            rule: 'Prefer async/await',
            repoId: 'global',
            severity: 'high',
            scope: 'file',
            path: '**/*.ts',
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain('Kody Rule created successfully.');
        expect(output).toContain('Rule UUID: rule-1');
        expect(output).toContain('Repository ID: global');
        expect(mockRulesService.createRule).toHaveBeenCalledWith(
            expect.objectContaining({ repositoryId: 'global' }),
            { team: undefined },
        );
    });

    it('prints JSON for view when requested', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRulesService.viewRules.mockResolvedValue([
            {
                uuid: 'rule-2',
                repositoryId: 'global',
                title: 'Rule',
                rule: 'Description',
            },
        ]);

        await rulesViewAction({ json: true, repoId: 'global' });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(JSON.parse(output)).toEqual([
            {
                uuid: 'rule-2',
                repositoryId: 'global',
                title: 'Rule',
                rule: 'Description',
            },
        ]);
        expect(mockRulesService.viewRules).toHaveBeenCalledWith(
            expect.objectContaining({ repositoryId: 'global' }),
            { team: undefined },
        );
    });

    it('prints centralized PR information when create returns centralized-pr mode', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRulesService.createRule.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/123',
            prNumber: 123,
            message: 'Queued in active centralized PR.',
        } as any);

        await rulesCreateAction({
            title: 'Use async/await',
            rule: 'Prefer async/await',
            repoId: 'global',
        });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            'Kody Rule change proposed through centralized pull request.',
        );
        expect(output).toContain('PR URL: https://example.com/pr/123');
        expect(output).toContain('PR Number: 123');
    });

    it('converts service errors to CLI exits', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        mockRulesService.updateRule.mockRejectedValue(new Error('boom'));

        await expect(
            rulesUpdateAction({
                uuid: 'rule-1',
                rule: 'x',
            }),
        ).rejects.toBeInstanceOf(CliExitError);

        expect(errorSpy).toHaveBeenCalled();
    });

    it('requires --uuid on update subcommand', () => {
        const updateSubcommand = rulesCommand.commands
            .find((subcommand) => subcommand.name() === 'update')
            ?.options.find((option) => option.long === '--uuid');

        expect(updateSubcommand?.required).toBe(true);
    });

    it.each([
        ['pause', rulesPauseAction, 'paused', 'paused'],
        ['resume', rulesResumeAction, 'active', 'resumed'],
        ['delete', rulesDeleteAction, 'deleted', 'deleted'],
    ] as const)(
        '%s sends the matching status and reports the rules',
        async (_name, action, status, label) => {
            const logSpy = vi
                .spyOn(console, 'log')
                .mockImplementation(() => {});
            mockRulesService.changeStatus.mockResolvedValue([
                {
                    uuid: 'rule-1',
                    title: 'Rule',
                    rule: 'Desc',
                    status,
                },
            ]);

            await action({ uuid: ['rule-1'], team: 'Platform' });

            expect(mockRulesService.changeStatus).toHaveBeenCalledWith(
                ['rule-1'],
                status,
                { team: 'Platform' },
            );
            const output = logSpy.mock.calls
                .map((call) => call.join(' '))
                .join('\n');
            expect(output).toContain(`1 Kody Rule(s) ${label}.`);
            expect(output).toContain('Rule UUID: rule-1');
        },
    );

    it('prints the centralized PR when a status change is proposed', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockRulesService.changeStatus.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/7',
        });

        await rulesDeleteAction({ uuid: ['rule-1'] });

        const output = logSpy.mock.calls
            .map((call) => call.join(' '))
            .join('\n');
        expect(output).toContain(
            'Kody Rule change proposed through centralized pull request.',
        );
        expect(output).toContain('PR URL: https://example.com/pr/7');
    });

    it('collects repeated and comma-separated --uuid values', async () => {
        mockRulesService.changeStatus.mockResolvedValue([]);
        vi.spyOn(console, 'log').mockImplementation(() => {});

        await rulesCommand.parseAsync(
            ['pause', '--uuid', 'a,b', '--uuid', 'c', '--json'],
            { from: 'user' },
        );

        expect(mockRulesService.changeStatus).toHaveBeenCalledWith(
            ['a', 'b', 'c'],
            'paused',
            { team: undefined },
        );
    });

    it('exits with the service error when a status change is refused', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        mockRulesService.changeStatus.mockRejectedValue(
            new Error('requires a logged-in user'),
        );

        await expect(
            rulesPauseAction({ uuid: ['rule-1'] }),
        ).rejects.toBeInstanceOf(CliExitError);
        expect(errorSpy).toHaveBeenCalled();
    });
});
