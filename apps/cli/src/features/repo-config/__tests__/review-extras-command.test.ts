import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock(
    '../../../services/review-messages.service.js',
    async (importOriginal) => {
        const actual =
            await importOriginal<
                typeof import('../../../services/review-messages.service.js')
            >();
        return {
            ...actual,
            reviewMessagesService: {
                show: vi.fn(),
                set: vi.fn(),
                unset: vi.fn(),
            },
        };
    },
);

vi.mock(
    '../../../services/review-language.service.js',
    async (importOriginal) => {
        const actual =
            await importOriginal<
                typeof import('../../../services/review-language.service.js')
            >();
        return {
            ...actual,
            reviewLanguageService: { show: vi.fn(), set: vi.fn() },
        };
    },
);

vi.mock('../../../services/custom-agents.service.js', () => ({
    customAgentsService: {
        listKnowledge: vi.fn(),
        discoverKnowledge: vi.fn(),
        addKnowledge: vi.fn(),
        removeKnowledge: vi.fn(),
        linkKnowledge: vi.fn(),
    },
}));

vi.mock('../../../services/review-settings.service.js', () => ({
    reviewSettingsService: {
        resolveRepositoryReference: vi.fn(async (ref: string) =>
            ref === '.' ? 'kodustech/kodus-ai' : ref,
        ),
    },
}));

vi.mock('../../../utils/logger.js', () => ({
    cliInfo: vi.fn(),
    cliError: vi.fn(),
}));

vi.mock('../../../utils/cli-exit.js', () => ({
    exitWithCode: vi.fn(),
}));

import { customAgentsService } from '../../../services/custom-agents.service.js';
import { reviewLanguageService } from '../../../services/review-language.service.js';
import { reviewMessagesService } from '../../../services/review-messages.service.js';
import { exitWithCode } from '../../../utils/cli-exit.js';
import { cliError } from '../../../utils/logger.js';
import { registerRemoteRepositoryConfig } from '../command.js';

function program(): Command {
    const root = new Command('kodus').exitOverride();
    const config = root.command('config');
    registerRemoteRepositoryConfig(config.command('remote'));
    return root;
}

async function run(...args: string[]) {
    await program().parseAsync(['config', 'remote', ...args], {
        from: 'user',
    });
}

const scope = {
    level: 'repository',
    repositoryId: 'r1',
    repositoryName: 'o/r',
};

describe('config remote messages | language | skills', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(reviewMessagesService.set).mockResolvedValue({
            team: 'Core',
            scope: scope as never,
            field: 'start.content',
            value: 'Hi',
            changed: true,
        });
        vi.mocked(customAgentsService.addKnowledge).mockResolvedValue({
            level: 'repository',
            items: [],
            changed: true,
        });
        vi.mocked(customAgentsService.linkKnowledge).mockResolvedValue({
            level: 'repository',
            items: [],
            changed: true,
        });
        vi.mocked(reviewLanguageService.set).mockResolvedValue({
            team: 'Core',
            language: 'pt-BR',
            name: 'Portuguese (Brazil)',
            isDefault: false,
        });
    });

    it('passes the repository, field, value and scope options to messages set', async () => {
        await run(
            'messages',
            'set',
            '.',
            'start',
            'Hi',
            '--directory',
            'apps/web',
            '--team',
            'core',
        );

        expect(reviewMessagesService.set).toHaveBeenCalledWith(
            { repository: '.', directory: 'apps/web', team: 'core' },
            'start',
            'Hi',
        );
    });

    it('refuses a value together with --from-file', async () => {
        await run(
            'messages',
            'set',
            '.',
            'end.content',
            'x',
            '--from-file',
            '/tmp/x',
        );

        expect(reviewMessagesService.set).not.toHaveBeenCalled();
        expect(vi.mocked(cliError).mock.calls[0][0]).toContain('not both');
        expect(exitWithCode).toHaveBeenCalled();
    });

    it('sets the team language', async () => {
        await run('language', 'set', 'pt-BR', '--team', 'core');

        expect(reviewLanguageService.set).toHaveBeenCalledWith('pt-BR', {
            team: 'core',
        });
    });

    it('adds several paths with repeated --link, resolving . from git', async () => {
        await run(
            'skills',
            'add',
            '.',
            'docs/a.md',
            '.claude/skills/x',
            '--link',
            'main-review',
            '--link',
            'security',
        );

        expect(customAgentsService.addKnowledge).toHaveBeenCalledWith(
            ['docs/a.md', '.claude/skills/x'],
            {
                team: undefined,
                repo: 'kodustech/kodus-ai',
                directory: undefined,
            },
            { kind: undefined, link: ['main-review', 'security'] },
        );
    });

    it('keeps global as global and maps unlink', async () => {
        await run('skills', 'unlink', 'global', 'docs/a.md', 'main-review');

        expect(customAgentsService.linkKnowledge).toHaveBeenCalledWith(
            'docs/a.md',
            ['main-review'],
            false,
            { team: undefined, repo: 'global', directory: undefined },
        );
    });

    it('lists the subcommands in help', () => {
        const remote = program()
            .commands.find((command) => command.name() === 'config')
            ?.commands.find((command) => command.name() === 'remote');
        const names = remote?.commands.map((command) => command.name());

        expect(names).toEqual(
            expect.arrayContaining(['messages', 'language', 'skills']),
        );
        const skills = remote?.commands.find(
            (command) => command.name() === 'skills',
        );
        expect(skills?.commands.map((command) => command.name())).toEqual([
            'list',
            'discover',
            'add',
            'remove',
            'link',
            'unlink',
        ]);
    });
});
