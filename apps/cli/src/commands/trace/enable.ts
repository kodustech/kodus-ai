import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    isLegacyDecisionsCommand,
    parseAgents,
    removeClaudeCompatibleHooks,
    removeCodexNotify,
    removeCursorLegacyHooks,
    resolveCodexConfigPath,
} from './hooks.js';
import { installSessionHooks } from './session-hooks-install.js';
import { installCursorSessionHooks } from './session-hooks-install-cursor.js';
import { installCodexSessionHooks } from './session-hooks-install-codex.js';
import { gitHooksService } from '../../services/git-hooks.service.js';
import { configureTraceRefspec } from '../../services/trace/decision-branch.service.js';
import { repoStoreDir } from '../../services/trace/store-paths.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

interface EnableOptions {
    agents?: string;
    codexConfig?: string;
}

export async function enableAction(options: EnableOptions): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
    }

    const gitRoot = (await gitService.getGitRoot()).trim();

    let agents: Set<string>;
    try {
        agents = parseAgents(options.agents ?? 'claude,cursor,codex');
    } catch (error) {
        cliError(chalk.red((error as Error).message));
        exitWithCode(1);
    }

    const codexConfigPath = resolveCodexConfigPath(options.codexConfig);

    // 1. Clear anything the previous release wrote. This has to happen before
    //    the install, or a settings file ends up running both the dead
    //    `kodus decisions` hooks and the new ones on the same events.
    const legacyClaude = await removeClaudeCompatibleHooks(
        gitRoot,
        isLegacyDecisionsCommand,
    );
    const legacyCursor = await removeCursorLegacyHooks(gitRoot);
    const legacyCodexNotify = await removeCodexNotify(codexConfigPath);
    const legacyRemoved =
        legacyClaude.removed ||
        legacyCursor.removed ||
        legacyCodexNotify.removed;

    // 2. Session lifecycle hooks — the one capture path.
    let claudeStatus = 'skipped';
    if (agents.has('claude')) {
        const result = await installSessionHooks(gitRoot, 'claude-code');
        claudeStatus = result.changed ? 'installed' : 'already configured';
    }

    let cursorStatus = 'skipped';
    if (agents.has('cursor')) {
        const result = await installCursorSessionHooks(gitRoot);
        cursorStatus = result.changed ? 'installed' : 'already configured';
    }

    let codexStatus = 'skipped';
    if (agents.has('codex')) {
        const result = await installCodexSessionHooks(codexConfigPath);
        codexStatus = result.changed ? 'installed' : 'already configured';
    }

    // 3. Git hooks: the commit trailer and the detached pre-push distillation.
    let gitHookStatus: string;
    try {
        const hooksDir = await gitService.getHooksDir();
        const result = await gitHooksService.install(hooksDir);
        gitHookStatus =
            result.installed.length > 0
                ? `installed (${result.installed.join(', ')})`
                : 'already configured';
    } catch (error) {
        gitHookStatus = `failed: ${(error as Error).message}`;
    }

    // 4. Make sure a plain `git fetch` brings the decision branch down.
    const refspec = await configureTraceRefspec(gitRoot).catch(() => ({
        configured: false,
        reason: 'unavailable',
    }));

    cliInfo(chalk.green('✓ Kodus Trace enabled for this repository.'));
    if (legacyRemoved) {
        cliInfo(
            chalk.dim(
                '  Removed hooks from the previous release (kodus decisions ...)',
            ),
        );
    }
    cliInfo(`  Claude Code session hooks: ${claudeStatus}`);
    cliInfo(`  Cursor session hooks: ${cursorStatus}`);
    cliInfo(`  Codex session hooks: ${codexStatus}`);
    cliInfo(`  Git hooks: ${gitHookStatus}`);
    cliInfo(
        `  Decision branch fetch refspec: ${
            refspec.configured ? 'configured' : (refspec.reason ?? 'skipped')
        }`,
    );
    cliInfo(chalk.dim(`  Local store: ${repoStoreDir(gitRoot)}`));
    cliInfo(
        chalk.dim(
            '  Nothing is written inside the repository. Run `kodus trace status` to check.',
        ),
    );
}
