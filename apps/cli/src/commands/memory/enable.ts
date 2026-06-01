import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    parseAgents,
    installClaudeCompatibleHooks,
    installCodexNotify,
    resolveCodexConfigPath,
} from './hooks.js';
import { installSessionHooks } from './session-hooks-install.js';
import { installCursorSessionHooks } from './session-hooks-install-cursor.js';
import { installCodexSessionHooks } from './session-hooks-install-codex.js';
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

    const installClaudeCompat = agents.has('claude') || agents.has('cursor');
    const installCodex = agents.has('codex');

    // 1. Decision capture hooks (Claude Code / Cursor)
    let captureStatus = 'skipped';
    if (installClaudeCompat) {
        const result = await installClaudeCompatibleHooks(gitRoot);
        captureStatus = result.changed ? 'installed' : 'already configured';
    }

    // 2. Session tracking hooks (Claude Code)
    let sessionStatus = 'skipped';
    if (agents.has('claude')) {
        const result = await installSessionHooks(gitRoot, 'claude-code');
        sessionStatus = result.changed ? 'installed' : 'already configured';
    }

    // 3. Session tracking hooks (Cursor — native .cursor/hooks.json)
    let cursorSessionStatus = 'skipped';
    if (agents.has('cursor')) {
        const result = await installCursorSessionHooks(gitRoot);
        cursorSessionStatus = result.changed
            ? 'installed'
            : 'already configured';
    }

    // 4. Codex notify + session hooks
    let codexStatus = 'skipped';
    let codexSessionStatus = 'skipped';
    if (installCodex) {
        const codexConfigPath = resolveCodexConfigPath(options.codexConfig);
        const notifyResult = await installCodexNotify(codexConfigPath);
        if (notifyResult.changed) {
            codexStatus = 'installed';
        } else if (notifyResult.skipped) {
            codexStatus = 'skipped (existing notify entry)';
        } else {
            codexStatus = 'already configured';
        }

        const sessionResult =
            await installCodexSessionHooks(codexConfigPath);
        codexSessionStatus = sessionResult.changed
            ? 'installed'
            : 'already configured';
    }

    // Summary
    cliInfo(chalk.green('\u2713 Decisions enabled for this repository.'));
    cliInfo(`  Decision capture hooks: ${captureStatus}`);
    cliInfo(`  Claude Code session hooks: ${sessionStatus}`);
    cliInfo(`  Cursor session hooks: ${cursorSessionStatus}`);
    cliInfo(`  Codex notify: ${codexStatus}`);
    cliInfo(`  Codex session hooks: ${codexSessionStatus}`);
}
