import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    removeClaudeCompatibleHooks,
    removeCodexNotify,
    removeCursorLegacyHooks,
    resolveCodexConfigPath,
} from './hooks.js';
import { removeSessionHooks } from './session-hooks-install.js';
import { removeCursorSessionHooks } from './session-hooks-install-cursor.js';
import { removeCodexSessionHooks } from './session-hooks-install-codex.js';
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
                removeClaudeCompatibleHooks: true,
                removeCursorHooks: true,
                removeCodexHooks: true,
                removeGitHooks: true,
                preserveLocalStore: true,
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

        const claudeResult = await removeSessionHooks(gitRoot);
        const claudeLegacy = await removeClaudeCompatibleHooks(gitRoot);
        const cursorResult = await removeCursorSessionHooks(gitRoot);
        const cursorLegacy = await removeCursorLegacyHooks(gitRoot);
        const codexConfigPath = resolveCodexConfigPath();
        const codexNotify = await removeCodexNotify(codexConfigPath);
        const codexResult = await removeCodexSessionHooks(codexConfigPath);

        let gitHooks = 'not found';
        try {
            const hooksDir = await gitService.getHooksDir();
            const removed = await gitHooksService.uninstall(hooksDir);
            gitHooks =
                removed.removed.length > 0
                    ? `removed (${removed.removed.join(', ')})`
                    : 'not found';
        } catch {
            gitHooks = 'not found';
        }

        cliInfo(chalk.green('✓ Kodus Trace hooks removed.'));
        cliInfo(
            `  Claude Code session hooks: ${
                claudeResult.removed || claudeLegacy.removed
                    ? 'removed'
                    : 'not found'
            }`,
        );
        cliInfo(
            `  Cursor session hooks: ${
                cursorResult.removed || cursorLegacy.removed
                    ? 'removed'
                    : 'not found'
            }`,
        );
        cliInfo(
            `  Codex session hooks: ${
                codexResult.removed || codexNotify.removed
                    ? 'removed'
                    : 'not found'
            }`,
        );
        cliInfo(`  Git hooks: ${gitHooks}`);
        cliInfo(
            chalk.dim(
                '  The local store under ~/.kodus/sessions was left in place.',
            ),
        );
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
