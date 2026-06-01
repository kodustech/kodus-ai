import { Command } from 'commander';
import chalk from 'chalk';
import { cliError } from '../utils/logger.js';
import { runHunk } from '../utils/hunk.js';

export const diffCommand = new Command('diff')
    .description(
        'Open the current changeset in the Hunk terminal diff viewer (wraps `hunk diff`)',
    )
    .allowUnknownOption(true)
    .helpOption(false)
    .argument('[args...]', 'Arguments forwarded to `hunk diff`')
    .action(async (_args: string[], _opts, command: Command) => {
        const forwarded = command.args;

        try {
            const { exitCode } = await runHunk(['diff', ...forwarded]);
            if (exitCode !== 0) {
                process.exit(exitCode);
            }
        } catch (error) {
            cliError(
                chalk.red(
                    `hunk diff failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                ),
            );
            process.exit(1);
        }
    });
