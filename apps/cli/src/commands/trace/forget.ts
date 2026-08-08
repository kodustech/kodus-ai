import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import { forgetDecision } from '../../services/local-session-store.service.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

export async function forgetAction(id: string): Promise<void> {
    if (!id) {
        cliError(chalk.red('Usage: kodus trace forget <id>'));
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
    const found = await forgetDecision(gitRoot, id);
    if (found) {
        cliInfo(chalk.green(`Forgot decision ${id}.`));
        exitWithCode(0);
    } else {
        cliInfo(chalk.yellow(`No decision found with id ${id}.`));
        exitWithCode(0);
    }
}
