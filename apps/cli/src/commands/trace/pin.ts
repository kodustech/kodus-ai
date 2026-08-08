import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import { pinDecision } from '../../services/local-session-store.service.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

export async function pinAction(id: string): Promise<void> {
    if (!id) {
        cliError(chalk.red('Usage: kodus trace pin <id>'));
        exitWithCode(1);
        return;
    }

    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
        return;
    }

    const gitRoot = (await gitService.getGitRoot()).trim();
    const found = await pinDecision(gitRoot, id);
    if (found) {
        cliInfo(chalk.green(`Pinned decision ${id}.`));
        exitWithCode(0);
    } else {
        cliInfo(chalk.yellow(`No decision found with id ${id}.`));
        exitWithCode(0);
    }
}
