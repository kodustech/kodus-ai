import chalk from 'chalk';
import ora from 'ora';
import { authService } from '../../services/auth.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export async function logoutAction(): Promise<void> {
    const spinner = ora();

    try {
        const isAuthenticated = await authService.isAuthenticated();

        if (!isAuthenticated) {
            cliInfo(chalk.yellow('\nNot authenticated.'));
            return;
        }

        spinner.start(chalk.blue('Logging out...'));

        await authService.logout();

        spinner.succeed(chalk.green('Logged out successfully'));
    } catch (error) {
        spinner.fail(chalk.red('Logout failed'));
        if (error instanceof Error) {
            cliError(chalk.red(error.message));
        }
        exitWithCode(1);
    }
}
