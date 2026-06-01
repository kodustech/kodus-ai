import type { Command } from 'commander';

export function applyCommanderBehavior(command: Command): void {
    command.exitOverride();
    command.configureOutput({
        outputError: () => {},
    });

    for (const subcommand of command.commands) {
        applyCommanderBehavior(subcommand);
    }
}
