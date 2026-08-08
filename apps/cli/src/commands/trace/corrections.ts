import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    forgetDecision,
    pinDecision,
    unpinDecision,
} from '../../services/trace/overrides.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

async function requireGitRoot(): Promise<string | null> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
        return null;
    }
    return (await gitService.getGitRoot()).trim();
}

/** Drop a decision the model got wrong. Recall stops returning it. */
export async function forgetAction(decisionId: string): Promise<void> {
    const gitRoot = await requireGitRoot();
    if (!gitRoot) {
        return;
    }

    const overrides = await forgetDecision(gitRoot, decisionId);
    cliInfo(chalk.green(`✓ Forgot decision ${decisionId}.`));
    cliInfo(chalk.dim(`  ${overrides.forgotten.length} forgotten in total.`));
}

/** Mark a decision that should always make the context pack. */
export async function pinAction(
    decisionId: string,
    options: { remove?: boolean } = {},
): Promise<void> {
    const gitRoot = await requireGitRoot();
    if (!gitRoot) {
        return;
    }

    if (options.remove) {
        const overrides = await unpinDecision(gitRoot, decisionId);
        cliInfo(chalk.green(`✓ Unpinned decision ${decisionId}.`));
        cliInfo(chalk.dim(`  ${overrides.pinned.length} pinned in total.`));
        return;
    }

    const overrides = await pinDecision(gitRoot, decisionId);
    cliInfo(chalk.green(`✓ Pinned decision ${decisionId}.`));
    cliInfo(chalk.dim(`  ${overrides.pinned.length} pinned in total.`));
}
