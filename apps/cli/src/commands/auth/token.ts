import chalk from 'chalk';
import ora from 'ora';
import { authService } from '../../services/auth.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export async function tokenAction(): Promise<void> {
    const spinner = ora();

    try {
        const isAuthenticated = await authService.isAuthenticated();

        if (!isAuthenticated) {
            cliInfo(
                chalk.yellow('\nYou need to be logged in to generate a token.'),
            );
            cliInfo(chalk.dim('Run `kodus auth login` first.'));
            return;
        }

        spinner.start(chalk.blue('Generating token...'));

        const token = await authService.generateCIToken();

        spinner.succeed(chalk.green('Token generated!'));

        cliInfo(chalk.bold('\nCI/CD Token\n'));
        cliInfo(chalk.dim('Use this token in your CI/CD pipelines:'));
        cliInfo(chalk.cyan(`\n${token}\n`));
        cliInfo(chalk.dim('Set as environment variable:'));
        cliInfo(chalk.dim('  export KODUS_TOKEN=<token>'));
        cliInfo(
            chalk.yellow(
                '\n⚠️  Keep this token secret! It provides access to your account.',
            ),
        );
    } catch (error) {
        spinner.fail(chalk.red('Failed to generate token'));
        if (error instanceof Error) {
            cliError(chalk.red(error.message));
        }
        exitWithCode(1);
    }
}
