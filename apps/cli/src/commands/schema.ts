import { Command } from 'commander';
import chalk from 'chalk';
import {
    buildCommandSchema,
    findCommandByPath,
    getCommandPath,
} from '../utils/command-schema.js';
import { createCommandContext } from '../utils/command-context.js';
import {
    buildAgentErrorEnvelope,
    buildAgentSuccessEnvelope,
    emitAgentEnvelope,
} from '../utils/command-output.js';
import {
    normalizeCommandError,
    CommandError,
} from '../utils/command-errors.js';
import type { GlobalOptions } from '../types/cli.js';
import { cliError, cliInfo } from '../utils/logger.js';
import { exitWithCode } from '../utils/cli-exit.js';
import fs from 'fs/promises';

export function createSchemaCommand(getProgram: () => Command): Command {
    return new Command('schema')
        .description('Inspect command schema for agent/tool introspection')
        .option(
            '--command <path>',
            'Command path (example: "review" or "pr suggestions")',
        )
        .action(
            async (
                options: { command?: string },
                cmd: Command,
            ): Promise<void> => {
                const globalOpts = cmd.optsWithGlobals() as GlobalOptions;
                const ctx = createCommandContext('schema', globalOpts);

                try {
                    const root = getProgram();
                    const target = options.command
                        ? findCommandByPath(root, options.command)
                        : root;

                    if (!target) {
                        throw new CommandError(
                            'INVALID_INPUT',
                            `Unknown command path: ${options.command}`,
                        );
                    }

                    const schema = buildCommandSchema(
                        target,
                        (() => {
                            const fullPath = getCommandPath(target);
                            const lastSpace = fullPath.lastIndexOf(' ');
                            return lastSpace === -1
                                ? ''
                                : fullPath.slice(0, lastSpace);
                        })(),
                    );

                    if (ctx.isAgent) {
                        await emitAgentEnvelope(
                            buildAgentSuccessEnvelope(
                                ctx.command,
                                schema,
                                ctx.startedAt,
                            ),
                            ctx.outputFile,
                        );
                        return;
                    }

                    const output = JSON.stringify(schema, null, 2);
                    if (globalOpts.output) {
                        await fs.writeFile(globalOpts.output, output, 'utf-8');
                        cliInfo(
                            chalk.green(
                                `\nOutput saved to ${globalOpts.output}`,
                            ),
                        );
                        return;
                    }

                    cliInfo(output);
                } catch (error) {
                    const normalized = normalizeCommandError(error);
                    if (ctx.isAgent) {
                        await emitAgentEnvelope(
                            buildAgentErrorEnvelope(
                                ctx.command,
                                {
                                    code: normalized.code,
                                    message: normalized.message,
                                    details: normalized.details,
                                },
                                ctx.startedAt,
                            ),
                            ctx.outputFile,
                        );
                        if (normalized.exitCode > 0) {
                            exitWithCode(normalized.exitCode);
                        }
                        return;
                    }

                    cliError(chalk.red(normalized.message));
                    exitWithCode(normalized.exitCode);
                }
            },
        );
}
