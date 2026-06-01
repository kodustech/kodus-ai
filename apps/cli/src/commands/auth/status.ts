import chalk from 'chalk';
import ora from 'ora';
import { authService } from '../../services/auth.service.js';
import { loadConfig } from '../../utils/config.js';
import { checkTrialStatus } from '../../utils/rate-limit.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export async function statusAction(): Promise<void> {
    const spinner = ora();

    try {
        const isAuthenticated = await authService.isAuthenticated();

        if (isAuthenticated) {
            const credentials = await authService.getCredentials();
            const teamConfig = await loadConfig();

            const hasTeamKey = !!teamConfig?.teamKey;
            const hasUserEmail = !!credentials?.user?.email;

            if (!hasUserEmail && hasTeamKey) {
                cliInfo(chalk.bold('\nAuthentication Status\n'));
                cliInfo(`${chalk.dim('Mode:')}  ${chalk.green('Team Key')}`);
                cliInfo(
                    `${chalk.dim('Organization:')} ${teamConfig?.organizationName ?? '(unknown)'}`,
                );
                cliInfo(
                    `${chalk.dim('Team:')}         ${teamConfig?.teamName ?? '(unknown)'}`,
                );
                cliInfo(
                    `${chalk.dim('Token:')}        ${chalk.green('Configured')}`,
                );
                return;
            }

            if (!credentials) {
                cliInfo(chalk.yellow('\nNo credentials found.'));
                return;
            }

            cliInfo(chalk.bold('\nAuthentication Status\n'));
            cliInfo(`${chalk.dim('Mode:')}  ${chalk.green('Logged In')}`);
            cliInfo(
                `${chalk.dim('Email:')} ${credentials.user?.email ?? '(unknown)'}`,
            );

            const expiresAt = new Date(credentials.expiresAt);
            const timeUntilExpiry = expiresAt.getTime() - Date.now();
            const hoursUntilExpiry = Math.floor(
                timeUntilExpiry / (1000 * 60 * 60),
            );

            if (timeUntilExpiry > 0) {
                if (hoursUntilExpiry < 1) {
                    cliInfo(
                        `${chalk.dim('Token:')}  ${chalk.yellow('Expires in < 1 hour')}`,
                    );
                } else if (hoursUntilExpiry < 24) {
                    cliInfo(
                        `${chalk.dim('Token:')}  ${chalk.yellow(`Expires in ${hoursUntilExpiry} hours`)}`,
                    );
                } else {
                    cliInfo(`${chalk.dim('Token:')}  ${chalk.green('Valid')}`);
                }
            } else {
                cliInfo(`${chalk.dim('Token:')}  ${chalk.red('Expired')}`);
                cliInfo(
                    chalk.yellow(
                        '\nYour session has expired. Run `kodus auth login` to refresh.',
                    ),
                );
                return;
            }

            if (credentials.user?.orgs && credentials.user.orgs.length > 0) {
                cliInfo(`${chalk.dim('Organizations:')}`);
                credentials.user.orgs.forEach((org) => {
                    cliInfo(`  ${chalk.dim('•')} ${org}`);
                });
            }
        } else {
            spinner.start(chalk.blue('Checking trial status...'));

            const trialStatus = await checkTrialStatus();

            spinner.stop();

            cliInfo(chalk.bold('\nAuthentication Status\n'));
            cliInfo(`${chalk.dim('Mode:')}           ${chalk.yellow('Trial')}`);
            cliInfo(
                `${chalk.dim('Reviews today:')} ${trialStatus.reviewsUsed}/${trialStatus.reviewsLimit}`,
            );
            cliInfo(
                `${chalk.dim('Files limit:')}   ${trialStatus.filesLimit} per review`,
            );
            cliInfo(
                `${chalk.dim('Resets at:')}     ${new Date(trialStatus.resetsAt).toLocaleString()}`,
            );

            if (trialStatus.isLimited) {
                cliInfo(chalk.yellow('\n⚡ Daily limit reached!'));
            }

            cliInfo(
                chalk.dim('\nSign up to remove limits: ') +
                    chalk.cyan('kodus auth login'),
            );
        }
    } catch (error) {
        spinner.fail(chalk.red('Failed to get status'));
        if (error instanceof Error) {
            cliError(chalk.red(error.message));
        }
        exitWithCode(1);
    }
}
