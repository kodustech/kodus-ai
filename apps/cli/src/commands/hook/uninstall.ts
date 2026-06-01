import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { gitService } from '../../services/git.service.js';
import { KODUS_MARKER } from './install.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import type { GlobalOptions } from '../../types/cli.js';
import { createCommandContext } from '../../utils/command-context.js';
import {
    buildAgentErrorEnvelope,
    buildAgentSuccessEnvelope,
    emitAgentEnvelope,
} from '../../utils/command-output.js';
import {
    CommandError,
    normalizeCommandError,
} from '../../utils/command-errors.js';

export async function uninstallAction(
    options: { dryRun?: boolean } = {},
    globalOpts?: GlobalOptions,
): Promise<void> {
    const ctx = createCommandContext('hook uninstall', {
        format: globalOpts?.format ?? 'terminal',
        output: globalOpts?.output,
        verbose: globalOpts?.verbose ?? false,
        quiet: globalOpts?.quiet ?? false,
        agent: globalOpts?.agent ?? false,
    });

    try {
        const isRepo = await gitService.isGitRepository();
        if (!isRepo) {
            throw new CommandError('NOT_IN_GIT_REPO', 'Not a git repository.');
        }

        const gitRoot = await gitService.getGitRoot();
        const hookPath = path.join(gitRoot.trim(), '.git', 'hooks', 'pre-push');

        let content: string;
        try {
            content = await fs.readFile(hookPath, 'utf-8');
        } catch {
            cliInfo(chalk.yellow('No pre-push hook found.'));
            return;
        }

        if (options.dryRun) {
            const payload = {
                action: 'hook uninstall',
                path: hookPath,
                installedByKodus: content.includes(KODUS_MARKER),
                fileExists: true,
            };
            if (ctx.isAgent) {
                await emitAgentEnvelope(
                    buildAgentSuccessEnvelope(
                        ctx.command,
                        payload,
                        ctx.startedAt,
                    ),
                    ctx.outputFile,
                );
                return;
            }

            cliInfo(chalk.cyan('Dry run: no changes were made.'));
            cliInfo(JSON.stringify(payload, null, 2));
            return;
        }

        if (!content.includes(KODUS_MARKER)) {
            cliInfo(
                chalk.yellow(
                    'The pre-push hook was not installed by kodus. Skipping.',
                ),
            );
            return;
        }

        await fs.unlink(hookPath);
        cliInfo(chalk.green('✓ Pre-push hook removed successfully.'));
    } catch (error) {
        const normalized = normalizeCommandError(error);
        if (ctx.isAgent) {
            await emitAgentEnvelope(
                buildAgentErrorEnvelope(ctx.command, normalized, ctx.startedAt),
                ctx.outputFile,
            );
            exitWithCode(normalized.exitCode);
        }

        cliError(chalk.red(`Error: ${normalized.message}`));
        exitWithCode(normalized.exitCode);
    }
}
