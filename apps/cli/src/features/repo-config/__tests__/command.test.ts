import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerRepositoryConfigCommand } from '../command.js';

describe('registerRepositoryConfigCommand', () => {
    it('registers the expected remote repository config subcommands', () => {
        const root = new Command('config');
        const remote = root.command('remote');

        registerRepositoryConfigCommand(remote, {
            description: 'Repository config test surface',
        });

        const subcommands = remote.commands.map((command) => command.name());
        expect(subcommands).toEqual(
            expect.arrayContaining([
                'add',
                'list',
                'show',
                'setup',
                'set',
                'open',
                'add-pattern',
                'remove-pattern',
                'add-ignore-file',
                'remove-ignore-file',
                'add-base-branch',
                'remove-base-branch',
                'add-ignore-title',
                'remove-ignore-title',
            ]),
        );
    });
});
