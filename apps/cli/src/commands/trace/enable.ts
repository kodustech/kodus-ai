import chalk from 'chalk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs/promises';
import path from 'path';
import { gitService } from '../../services/git.service.js';
import { parseAgents, resolveCodexConfigPath } from './hooks.js';
import { installSessionHooks } from './session-hooks-install.js';
import { installCursorSessionHooks } from './session-hooks-install-cursor.js';
import { installCodexSessionHooks } from './session-hooks-install-codex.js';
import {
    stripLegacyClaudeSettings,
    stripLegacyCursorHooks,
    stripLegacyCodexConfig,
} from '../../services/legacy-hooks-strip.service.js';
import { gitHooksService } from '../../services/git-hooks.service.js';
import { TRACE_ORPHAN_BRANCH } from '../../services/decision-recall.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

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

    // Strip every legacy `kodus decisions *` hook before installing.
    await stripLegacyClaudeSettings(gitRoot);
    await stripLegacyCursorHooks(gitRoot);
    const codexConfigPath = resolveCodexConfigPath(options.codexConfig);
    await stripLegacyCodexConfig(codexConfigPath);

    // Session lifecycle hooks only (no capture path).
    let sessionStatus = 'skipped';
    if (agents.has('claude')) {
        const result = await installSessionHooks(gitRoot, 'claude-code');
        sessionStatus = result.changed ? 'installed' : 'already configured';
    }

    let cursorSessionStatus = 'skipped';
    if (agents.has('cursor')) {
        const result = await installCursorSessionHooks(gitRoot);
        cursorSessionStatus = result.changed
            ? 'installed'
            : 'already configured';
    }

    let codexSessionStatus = 'skipped';
    if (agents.has('codex')) {
        const sessionResult = await installCodexSessionHooks(codexConfigPath);
        codexSessionStatus = sessionResult.changed
            ? 'installed'
            : 'already configured';
    }

    // pre-push distillation hook + prepare-commit-msg trailer support
    let gitHookStatus: string;
    try {
        const hooksDir = await gitService.getHooksDir();
        const result = await gitHooksService.install(hooksDir);
        gitHookStatus =
            result.installed.length > 0
                ? `installed (${result.installed.join(', ')})`
                : 'already configured';
    } catch {
        gitHookStatus = 'failed (fail-open)';
    }

    // Configure push refspec for the orphan decision branch so a plain push
    // ships decisions without extra config for teammates who clone later.
    let refspecStatus: string;
    try {
        await ensureTracePushRefspec(gitRoot);
        refspecStatus = 'configured';
    } catch {
        refspecStatus = 'failed (fail-open)';
    }

    cliInfo(chalk.green('\u2713 Trace enabled for this repository.'));
    cliInfo(`  Claude Code session hooks: ${sessionStatus}`);
    cliInfo(`  Cursor session hooks: ${cursorSessionStatus}`);
    cliInfo(`  Codex session hooks: ${codexSessionStatus}`);
    cliInfo(`  Git hooks (pre-push distill): ${gitHookStatus}`);
    cliInfo(`  Push refspec (${TRACE_ORPHAN_BRANCH}): ${refspecStatus}`);
    cliInfo(
        chalk.dim(
            '  Legacy `kodus decisions *` hooks were stripped if present.',
        ),
    );
}

async function ensureTracePushRefspec(repoRoot: string): Promise<void> {
    // remote.origin.push = refs/heads/kodus/trace/v1:refs/heads/kodus/trace/v1
    // Use git config --add only if not already present.
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['config', '--get-all', 'remote.origin.push'],
            { cwd: repoRoot },
        );
        if (stdout.includes(TRACE_ORPHAN_BRANCH)) {
            return;
        }
    } catch {
        // no existing push refspecs
    }

    // Also ensure origin exists
    try {
        await execFileAsync('git', ['remote', 'get-url', 'origin'], {
            cwd: repoRoot,
        });
    } catch {
        return; // no origin — skip
    }

    await execFileAsync(
        'git',
        [
            'config',
            '--add',
            'remote.origin.push',
            `+refs/heads/${TRACE_ORPHAN_BRANCH}:refs/heads/${TRACE_ORPHAN_BRANCH}`,
        ],
        { cwd: repoRoot },
    );

    // Keep default branch push behavior by also pushing matching branches if
    // no other push refspec was set. If user already had refspecs, leave them.
    void path;
    void fs;
}
