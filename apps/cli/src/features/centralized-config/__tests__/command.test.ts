import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerCentralizedConfigCommand } from '../command.js';

describe('registerCentralizedConfigCommand', () => {
    it('registers centralized config subcommands', () => {
        const root = new Command('config');
        const centralized = root.command('centralized');

        registerCentralizedConfigCommand(centralized);

        const subcommands = centralized.commands.map((command) =>
            command.name(),
        );

        expect(subcommands).toEqual(
            expect.arrayContaining([
                'status',
                'init',
                'sync',
                'disable',
                'download',
            ]),
        );
    });
});
