import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { applyCommanderBehavior } from '../commander-setup.js';

describe('commander setup', () => {
    it('applies exit override and suppresses default error output for subcommands', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const program = new Command();
        const config = new Command('config');
        config.option('-r, --remote [repository]');
        program.addCommand(config);

        applyCommanderBehavior(program);

        await expect(
            program.parseAsync(
                ['node', 'kodus', 'config', '-r', 'Wellington01/kodus-extension', 'setup'],
                { from: 'node' },
            ),
        ).rejects.toMatchObject({
            code: 'commander.excessArguments',
        });

        expect(errorSpy).not.toHaveBeenCalled();
    });
});
