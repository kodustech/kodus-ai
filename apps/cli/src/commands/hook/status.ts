import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { gitService } from '../../services/git.service.js';
import { KODUS_MARKER } from './install.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export async function statusAction(): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
    }

    const gitRoot = await gitService.getGitRoot();
    const hookPath = path.join(gitRoot.trim(), '.git', 'hooks', 'pre-push');

    let content: string;
    try {
        content = await fs.readFile(hookPath, 'utf-8');
    } catch {
        cliInfo(chalk.yellow('Pre-push hook: not installed'));
        return;
    }

    if (!content.includes(KODUS_MARKER)) {
        cliInfo(chalk.yellow('Pre-push hook: installed (not by kodus)'));
        return;
    }

    cliInfo(chalk.green('Pre-push hook: installed'));

    // Parse config from hook script
    const failOnMatch = content.match(/--fail-on\s+(\S+)/);
    const hasFast = content.includes('--fast');

    cliInfo(chalk.dim(`  Fail on: ${failOnMatch?.[1] ?? 'unknown'}`));
    cliInfo(chalk.dim(`  Fast mode: ${hasFast ? 'yes' : 'no'}`));
    cliInfo(chalk.dim(`  Path: ${hookPath}`));
}
