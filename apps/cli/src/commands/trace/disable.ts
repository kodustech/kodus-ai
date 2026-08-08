import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import { resolveCodexConfigPath } from './hooks.js';
import { removeSessionHooks } from './session-hooks-install.js';
import { removeCursorSessionHooks } from './session-hooks-install-cursor.js';
import { removeCodexSessionHooks } from './session-hooks-install-codex.js';
import {
    stripLegacyClaudeSettings,
    stripLegacyCursorHooks,
    stripLegacyCodexConfig,
} from '../../services/legacy-hooks-strip.service.js';
import { gitHooksService } from '../../services/git-hooks.service.js';
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

export async function disableAction(
    options: { dryRun?: boolean } = {},
    globalOpts?: GlobalOptions,
): Promise<void> {
    const ctx = createCommandContext('trace disable', {
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

        const gitRoot = (await gitService.getGitRoot()).trim();

        if (options.dryRun) {
            const payload = {
                action: 'trace disable',
                repositoryRoot: gitRoot,
                removeSessionHooks: true,
                removeCursorSessionHooks: true,
                removeCodexSessionHooks: true,
                removeGitHooks: true,
                stripLegacyDecisionsHooks: true,
                codexConfigPath: resolveCodexConfigPath(),
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

        const sessionResult = await removeSessionHooks(gitRoot);
        const cursorResult = await removeCursorSessionHooks(gitRoot);
        const codexConfigPath = resolveCodexConfigPath();
        const codexSessionResult =
            await removeCodexSessionHooks(codexConfigPath);

        // Also strip any leftover legacy decisions hooks
        await stripLegacyClaudeSettings(gitRoot);
        await stripLegacyCursorHooks(gitRoot);
        await stripLegacyCodexConfig(codexConfigPath);

        let gitHookRemoved = false;
        try {
            const hooksDir = await gitService.getHooksDir();
            const result = await gitHooksService.uninstall(hooksDir);
            gitHookRemoved = result.removed.length > 0;
        } catch {
            // fail-open
        }

        cliInfo(chalk.green('\u2713 Trace hooks removed.'));
        cliInfo(
            `  Claude Code session hooks: ${sessionResult.removed ? 'removed' : 'not found'}`,
        );
        cliInfo(
            `  Cursor session hooks: ${cursorResult.removed ? 'removed' : 'not found'}`,
        );
        cliInfo(
            `  Codex session hooks: ${codexSessionResult.removed ? 'removed' : 'not found'}`,
        );
        cliInfo(`  Git hooks: ${gitHookRemoved ? 'removed' : 'not found'}`);
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
